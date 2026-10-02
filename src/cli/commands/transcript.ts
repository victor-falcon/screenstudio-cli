import { Command, Option } from "commander";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { evaluate, globals } from "../context.js";
import { output, table, formatMs } from "../format.js";
import { numberValue } from "../validation.js";
import {
  editableWords, findPhrase, formatTime, parseEditedTranscript, parseRanges, planTranscriptEdit,
  renderEditableTranscript, type Paragraph, type Token, type TranscriptEditPlan,
} from "../transcript-edit.js";

interface Transcript {
  project: string;
  tokens: Token[];
  paragraphs: Paragraph[];
  generator: Record<string, unknown> | null;
  verbatim: boolean;
}

const CONTROLLER = `var p = ss.project(), ctrl = await ss.transcriptEditor(ss.editor(p));`;

const FETCH = `${CONTROLLER}
  return {
    project: p.name,
    tokens: ctrl.tokens.map(function (t) { return ss.tokenInfo(ctrl, t); }),
    paragraphs: ctrl.paragraphs.map(function (pg) { return { start: pg.tokens[0].index, end: pg.tokens[pg.tokens.length - 1].index }; }),
    generator: ctrl.client.currentGenerator ?? null, verbatim: ctrl.isVerbatimTranscript,
  };
`;

function fetchTranscript(cmd: Command): Promise<Transcript> {
  return evaluate<Transcript>(cmd, FETCH, 60_000);
}

// Re-resolves the token ranges in the app and refuses to act on a transcript that changed
// since it was read, so indices always refer to the words the user saw.
function pickTokens(transcript: Transcript, ranges: Array<[number, number]>): string {
  return `${CONTROLLER}
    var tokens = ctrl.tokens, ranges = ${JSON.stringify(ranges)};
    if (tokens.length !== ${transcript.tokens.length}) throw new Error('The transcript changed while the command ran. Run it again.');
    var picked = [];
    ranges.forEach(function (r) { for (var i = r[0]; i <= r[1]; i++) picked.push(tokens[i]); });
    var size = function (t) { return t.kind === 'word' ? t.text.length : 1; };
    // Selects tokens a..b inclusive, as a mouse selection in the transcript editor would.
    var selectRange = function (r) {
      var ts = ctrl.tokens, a = r[0], b = r[1];
      while (a < b && size(ts[a]) === 0) a++;
      while (b > a && size(ts[b]) === 0) b--;
      ctrl.setSelection({ anchor: { tokenIndex: a, charOffset: 0 }, focus: { tokenIndex: b, charOffset: size(ts[b]) } });
    };
    var replaceRange = function (a, b, text) {
      var ts = ctrl.tokens;
      if (a === b) { ctrl.applyWordRangeReplacement(ts[a], text, text.length); return true; }
      selectRange([a, b]);
      var result = ctrl.replaceCoveredWordsWithText(text);
      ctrl.clearSelection();
      return result === 'handled';
    };
  `;
}

interface Selection {
  ranges: Array<[number, number]>;
  text: string;
}

// Resolves positional token ranges or --text into token ranges and their words.
function selectTokens(transcript: Transcript, values: string[], opts: { text?: string; all?: boolean; occurrence?: string }, includeCut = false): Selection {
  const max = transcript.tokens.length - 1;
  let ranges: Array<[number, number]>;
  if (opts.text !== undefined) {
    if (values.length) throw new Error("Pass token ranges or --text, not both.");
    const words = transcript.tokens.filter(t => t.kind === "word" && t.text.trim() && (includeCut || t.present));
    const matches = findPhrase(words, opts.text);
    if (!matches.length) throw new Error(`Text not found${includeCut ? "" : " among the words in the video"}: "${opts.text}"`);
    if (opts.occurrence !== undefined) {
      const n = numberValue(opts.occurrence, "Occurrence", 1, matches.length);
      ranges = [matches[n - 1]];
    } else if (opts.all || matches.length === 1) {
      ranges = matches;
    } else {
      throw new Error(`"${opts.text}" appears ${matches.length} times (tokens ${matches.map(m => m[0]).join(", ")}). Pass --all or --occurrence <n>.`);
    }
  } else {
    if (!values.length) throw new Error("Pass token ranges (see transcript show --words) or --text.");
    ranges = parseRanges(values, max);
  }
  const text = ranges.map(([a, b]) => transcript.tokens.slice(a, b + 1).filter(t => t.kind === "word").map(t => t.text.trim()).filter(Boolean).join(" ")).join(" … ");
  return { ranges, text };
}

function selectionOptions(command: Command): Command {
  return command
    .argument("[ranges...]", "Token indexes or ranges, e.g. 12 40-58 (see transcript show --words)")
    .option("--text <phrase>", "Select a phrase instead (case and punctuation are ignored)")
    .option("--all", "With --text, act on every occurrence")
    .option("--occurrence <n>", "With --text, act on the nth occurrence (1-based)");
}

function renderParagraphs(transcript: Transcript, showCut: boolean, from = 0, to = Infinity): string[] {
  const lines: string[] = [];
  for (const [number, paragraph] of transcript.paragraphs.entries()) {
    if (paragraph.end < from || paragraph.start > to) continue;
    const tokens = transcript.tokens.slice(paragraph.start, paragraph.end + 1).filter(t => t.index >= from && t.index <= to);
    const first = tokens.find(t => t.present && t.playbackStartMs !== null);
    const pieces: string[] = [];
    const current: { group: { kind: "cut" | "hidden"; words: string[] } | null } = { group: null };
    const flush = () => {
      const group = current.group;
      if (group) pieces.push(group.kind === "cut" ? `[-${group.words.join(" ")}-]` : `{${group.words.join(" ")}}`);
      current.group = null;
    };
    for (const t of tokens) {
      if (t.kind === "gap") {
        if (!t.present) continue;
        flush();
        pieces.push(`(${((t.sourceEndMs - t.sourceStartMs) / 1000).toFixed(1)}s)`);
        continue;
      }
      const text = t.text.trim();
      if (!text) continue;
      const kind = !t.present ? "cut" : t.hidden ? "hidden" : null;
      if (kind === "cut" && !showCut) { flush(); continue; }
      if (!kind) { flush(); pieces.push(text); continue; }
      if (current.group?.kind !== kind) { flush(); current.group = { kind, words: [] }; }
      current.group!.words.push(text);
    }
    flush();
    if (!pieces.length) continue;
    lines.push(`¶${number + 1}  ${first ? formatTime(first.playbackStartMs!) : "cut  "}  #${paragraph.start}-${paragraph.end}`);
    lines.push(pieces.join(" "), "");
  }
  return lines;
}

const transcriptStatus = new Command("status")
  .description("Show whether the project has a transcript and what it contains")
  .action(async (_opts, cmd) => {
    const status = await evaluate<Record<string, unknown>>(cmd, `
      var p = ss.project(), ctrl = await ss.transcriptEditor(ss.editor(p), { allowMissing: true });
      var words = ctrl.tokens.filter(function (t) { return t.kind === 'word' && t.text.trim(); });
      return {
        ready: ctrl.isTranscriptReady, canGenerate: !!ctrl.client.canGenerate,
        generator: ctrl.client.currentGenerator ?? null, verbatim: ctrl.isVerbatimTranscript,
        words: words.length,
        cutWords: words.filter(function (t) { return !ctrl.getIsTokenPresent(t); }).length,
        hiddenWords: words.filter(function (t) { return t.isHidden; }).length,
        paragraphs: ctrl.paragraphs.length,
        fillerWords: ctrl.presentFillerTokens.length, longPauses: ctrl.tightenablePauseTokens.length,
      };
    `, 60_000);
    if (globals(cmd).json) return output(status, true);
    if (!status.ready) {
      console.log(status.canGenerate ? "No transcript yet. Run: screenstudio transcript generate --engine whisper" : "This recording has no microphone audio to transcribe.");
      return;
    }
    const generator = status.generator as Record<string, unknown> | null;
    console.log(`Transcript: ${status.words} words in ${status.paragraphs} paragraphs | generator: ${generator?.type ?? "unknown"}${status.verbatim ? " (verbatim)" : ""}`);
    console.log(`Cut from video: ${status.cutWords} words | Hidden from captions: ${status.hiddenWords} words`);
    console.log(`Filler words to remove: ${status.fillerWords}${status.verbatim ? "" : " (fillers are only detected in verbatim ElevenLabs transcripts)"} | Long pauses to tighten: ${status.longPauses}`);
  });

const transcriptShow = new Command("show")
  .description("Print the transcript by paragraph, or word by word with token indexes")
  .option("--words", "One line per token, with its index, time and state")
  .option("--cut", "Include words already cut from the video, as [-word-]")
  .option("--from <index>", "First token index to show")
  .option("--to <index>", "Last token index to show")
  .action(async (opts, cmd) => {
    const transcript = await fetchTranscript(cmd);
    const from = opts.from === undefined ? 0 : numberValue(opts.from, "From index");
    const to = opts.to === undefined ? Infinity : numberValue(opts.to, "To index");
    if (globals(cmd).json) {
      return output({ ...transcript, tokens: transcript.tokens.filter(t => t.index >= from && t.index <= to) }, true);
    }
    if (!opts.words) {
      console.log(renderParagraphs(transcript, !!opts.cut, from, to).join("\n").trimEnd());
      console.log("\nHidden from captions: {word} · cut from the video: [-word-] (with --cut) · pauses: (1.2s)");
      return;
    }
    const rows = transcript.tokens
      .filter(t => t.index >= from && t.index <= to && (t.kind === "gap" || t.text.trim()))
      .filter(t => opts.cut || t.present)
      .map(t => [
        String(t.index),
        t.present && t.playbackStartMs !== null ? formatTime(t.playbackStartMs) : "cut",
        t.kind === "gap" ? `(${((t.sourceEndMs - t.sourceStartMs) / 1000).toFixed(1)}s pause)` : t.text.trim(),
        [!t.present && "cut", t.hidden && "hidden", t.filler === 1 && "filler"].filter(Boolean).join(","),
      ]);
    table(["Token", "Time", "Text", "State"], rows);
  });

const transcriptText = new Command("text")
  .description("Write the transcript as editable text: delete words to cut them, retype words to fix captions")
  .option("-o, --output <path>", "Write to a file instead of stdout")
  .action(async (opts, cmd) => {
    const transcript = await fetchTranscript(cmd);
    const text = renderEditableTranscript(transcript.project, transcript.tokens, transcript.paragraphs);
    if (!opts.output) { process.stdout.write(text); return; }
    writeFileSync(resolve(opts.output), text);
    output({ success: true, path: resolve(opts.output), words: editableWords(transcript.tokens).length }, globals(cmd).json);
  });

function summarize(plan: TranscriptEditPlan, transcript: Transcript) {
  const cutMs = plan.cuts.reduce((sum, [a, b]) => sum + transcript.tokens[b].sourceEndMs - transcript.tokens[a].sourceStartMs, 0);
  return {
    cuts: plan.cuts.map(([start, end], i) => ({
      tokens: `${start}-${end}`, at: formatTime(transcript.tokens[start].playbackStartMs ?? 0), text: plan.cutText[i],
    })),
    corrections: plan.corrections,
    approxCutMs: Math.round(cutMs),
  };
}

function printPlan(summary: ReturnType<typeof summarize>) {
  for (const cut of summary.cuts) console.log(`cut  ${cut.at}  #${cut.tokens}  ${cut.text}`);
  for (const fix of summary.corrections) console.log(`fix  #${fix.start === fix.end ? fix.start : `${fix.start}-${fix.end}`}  "${fix.from}" → "${fix.to}"`);
  console.log(`${summary.cuts.length} cuts (~${formatMs(summary.approxCutMs)} of speech, plus the pauses around them) and ${summary.corrections.length} corrections.`);
}

async function applyPlan(cmd: Command, transcript: Transcript, plan: TranscriptEditPlan) {
  const expected = [
    ...plan.cuts.flatMap(([a, b]) => [[a, transcript.tokens[a].text], [b, transcript.tokens[b].text]]),
    ...plan.corrections.flatMap(c => [[c.start, transcript.tokens[c.start].text], [c.end, transcript.tokens[c.end].text]]),
  ];
  return evaluate<Record<string, unknown>>(cmd, `${pickTokens(transcript, plan.cuts)}
    ${JSON.stringify(expected)}.forEach(function (e) {
      if (!tokens[e[0]] || tokens[e[0]].text !== e[1]) throw new Error('The transcript changed while the command ran. Run it again.');
    });
    ss.flush(p);
    var before = p.playbackDurationMs, cut = picked.length ? ctrl.deleteTokens(picked) : false;
    if (picked.length && !cut) throw new Error('Screen Studio refused the cut (it cannot remove the entire video).');
    // Corrections can change word counts, so apply them from the end.
    var failed = [];
    ${JSON.stringify([...plan.corrections].sort((x, y) => y.start - x.start))}.forEach(function (c) {
      if (!replaceRange(c.start, c.end, c.to)) failed.push(c.start + '-' + c.end);
    });
    return { success: true, removedMs: Math.round(before - p.playbackDurationMs), newDurationMs: Math.round(p.playbackDurationMs),
      corrections: ${plan.corrections.length} - failed.length, failedCorrections: failed };
  `, 60_000);
}

async function runApply(cmd: Command, edited: string, opts: { dryRun?: boolean; cutsOnly?: boolean; yes?: boolean }, transcript: Transcript, confirm: boolean) {
  const json = globals(cmd).json;
  const plan = planTranscriptEdit(transcript.tokens, parseEditedTranscript(edited));
  if (opts.cutsOnly) plan.corrections = [];
  const summary = summarize(plan, transcript);
  if (!plan.cuts.length && !plan.corrections.length) return output({ success: true, message: "No changes", ...summary }, json);
  if (opts.dryRun) return json ? output({ dryRun: true, ...summary }, true) : printPlan(summary);
  if (confirm && !opts.yes) {
    printPlan(summary);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Apply these changes? [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return console.log("Nothing changed.");
  }
  const result = await applyPlan(cmd, transcript, plan);
  if (json) return output({ ...result, ...summary }, true);
  console.log(`Cut ${plan.cuts.length} ranges (${formatMs(result.removedMs as number)} removed, new duration ${formatMs(result.newDurationMs as number)}) and made ${result.corrections} text corrections. Undo with: screenstudio project undo`);
  const failed = result.failedCorrections as string[];
  if (failed.length) console.log(`Screen Studio could not correct tokens ${failed.join(", ")} (a correction must stay within one recording session).`);
}

const applyOptions = (command: Command) => command
  .option("--dry-run", "Print the cuts and corrections without changing the project")
  .option("--cuts-only", "Only cut deleted words; ignore text corrections");

const transcriptApply = applyOptions(new Command("apply")
  .description("Apply an edited transcript text: deleted words are cut from the video, retyped words fix the captions")
  .argument("<file>", "Text file produced by transcript text ('-' reads stdin)"))
  .action(async (file, opts, cmd) => {
    const edited = file === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(file), "utf8");
    await runApply(cmd, edited, opts, await fetchTranscript(cmd), false);
  });

const transcriptEdit = applyOptions(new Command("edit")
  .description("Edit the transcript in $EDITOR, then cut what you deleted")
  .option("-y, --yes", "Apply without asking for confirmation"))
  .action(async (opts, cmd) => {
    const transcript = await fetchTranscript(cmd);
    const dir = mkdtempSync(join(tmpdir(), "screenstudio-transcript-"));
    const file = join(dir, "transcript.txt");
    try {
      writeFileSync(file, renderEditableTranscript(transcript.project, transcript.tokens, transcript.paragraphs));
      const editor = process.env.VISUAL || process.env.EDITOR || "vi";
      // EDITOR may carry arguments ("code --wait"), so run it through the shell.
      const result = spawnSync(`${editor} ${JSON.stringify(file)}`, { stdio: "inherit", shell: true });
      if (result.status !== 0) throw new Error(`${editor} exited with status ${result.status}. Nothing changed.`);
      await runApply(cmd, readFileSync(file, "utf8"), opts, transcript, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

const transcriptCut = selectionOptions(new Command("cut")
  .description("Cut words out of the video (like ⌫ in Edit by transcript)"))
  .option("--dry-run", "Print what would be cut")
  .action(async (values, opts, cmd) => {
    const transcript = await fetchTranscript(cmd);
    const selection = selectTokens(transcript, values, opts);
    if (opts.dryRun) return output({ dryRun: true, ranges: selection.ranges, text: selection.text }, globals(cmd).json);
    output(await evaluate(cmd, `${pickTokens(transcript, selection.ranges)}
      ss.flush(p);
      var before = p.playbackDurationMs;
      if (!picked.some(function (t) { return ctrl.getIsTokenPresent(t); })) throw new Error('These words were already cut from the video.');
      if (!ctrl.deleteTokens(picked)) throw new Error('Screen Studio refused the cut (it cannot remove the entire video).');
      return { success: true, text: ${JSON.stringify(selection.text)}, removedMs: Math.round(before - p.playbackDurationMs),
        newDurationMs: Math.round(p.playbackDurationMs) };
    `, 60_000), globals(cmd).json);
  });

function hideCommand(name: string, hidden: boolean, description: string) {
  return selectionOptions(new Command(name).description(description))
    .action(async (values, opts, cmd) => {
      const transcript = await fetchTranscript(cmd);
      const selection = selectTokens(transcript, values, opts, !hidden);
      output(await evaluate(cmd, `${pickTokens(transcript, selection.ranges)}
        var words = picked.filter(function (t) { return t.kind === 'word' && t.wordIndex !== null; });
        if (!words.length) throw new Error('No words selected.');
        ctrl.setCoveredWordsHidden(words, ${hidden});
        return { success: true, text: ${JSON.stringify(selection.text)}, words: words.length };
      `, 60_000), globals(cmd).json);
    });
}

const transcriptRestore = selectionOptions(new Command("restore")
  .description("Bring cut words back into the video and unhide hidden ones"))
  .action(async (values, opts, cmd) => {
    const transcript = await fetchTranscript(cmd);
    const selection = selectTokens(transcript, values, opts, true);
    output(await evaluate(cmd, `${pickTokens(transcript, selection.ranges)}
      ss.flush(p);
      var before = p.playbackDurationMs;
      ranges.forEach(function (r) {
        selectRange(r);
        if (ctrl.canRestoreTarget) ctrl.restoreTarget();
      });
      ctrl.clearSelection();
      return { success: true, text: ${JSON.stringify(selection.text)}, restoredMs: Math.round(p.playbackDurationMs - before),
        newDurationMs: Math.round(p.playbackDurationMs) };
    `, 60_000), globals(cmd).json);
  });

const transcriptFix = new Command("fix")
  .description("Correct the text of a word or a range of words (the video is unchanged)")
  .argument("<range>", "Token index or range, e.g. 42 or 42-45")
  .argument("<text...>", "Replacement text")
  .action(async (range, words: string[], _opts, cmd) => {
    const transcript = await fetchTranscript(cmd);
    const [[start, end]] = parseRanges([range], transcript.tokens.length - 1);
    const text = words.join(" ").trim();
    if (!text) throw new Error("Replacement text is empty. To remove words, use transcript cut or hide.");
    output(await evaluate(cmd, `${pickTokens(transcript, [[start, end]])}
      var word = picked.filter(function (t) { return t.kind === 'word' && t.text; });
      if (!word.length) throw new Error('No words in range ${range}.');
      var before = word.map(function (t) { return t.text; }).join(' ');
      if (!replaceRange(word[0].index, word[word.length - 1].index, ${JSON.stringify(text)})) {
        throw new Error('Screen Studio could not replace these words (they must belong to one recording session).');
      }
      return { success: true, from: before, to: ${JSON.stringify(text)} };
    `, 60_000), globals(cmd).json);
  });

// Filled pauses per language. Screen Studio picks its list from the transcript locale and
// falls back to English when the generator has none (ElevenLabs), so --language lets the
// CLI find them itself. Spanish leaves out "este", which is mostly the demonstrative.
export const FILLER_WORDS: Record<string, string[]> = {
  en: ["um", "uh", "er", "ah", "hmm", "mhmm", "mm", "mmm", "huh", "uh-huh", "erm", "umm", "uhh"],
  es: ["eh", "ehm", "em", "emm", "mm", "mmm", "hmm"],
  de: ["äh", "ähm", "hm", "mhm", "öh", "öhm"],
  fr: ["euh", "hein", "ben", "bah"],
  pt: ["é", "hã", "ãh", "hum"],
  it: ["ehm", "eh", "mah"],
  pl: ["yyy", "eee", "hmm", "yhm"],
  nl: ["uh", "uhm", "eh", "ehm"],
};

const fillerKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim();

const transcriptFillers = new Command("fillers")
  .description("List filler words (um, uh, eh...) or cut them all with --remove")
  .option("--remove", "Cut every detected filler word from the video")
  .option("--language <code>", `Detect fillers with the CLI's list for a language (${Object.keys(FILLER_WORDS).join(", ")}) instead of Screen Studio's`)
  .action(async (opts, cmd) => {
    const json = globals(cmd).json;
    if (opts.language) {
      const list = FILLER_WORDS[String(opts.language).slice(0, 2).toLowerCase()];
      if (!list) throw new Error(`No filler list for ${opts.language}. Use one of: ${Object.keys(FILLER_WORDS).join(", ")}.`);
      const transcript = await fetchTranscript(cmd);
      const fillers = editableWords(transcript.tokens).filter(t => list.includes(fillerKey(t.text)));
      if (!opts.remove) {
        if (json) return output({ fillers }, true);
        return table(["Token", "Time", "Word"], fillers.map(t => [String(t.index), formatTime(t.playbackStartMs ?? 0), t.text.trim()]));
      }
      if (!fillers.length) return output({ success: true, removed: 0, removedMs: 0 }, json);
      const result = await evaluate<{ removedMs: number }>(cmd, `${pickTokens(transcript, fillers.map(t => [t.index, t.index] as [number, number]))}
        ss.flush(p);
        var before = p.playbackDurationMs;
        if (!ctrl.deleteTokens(picked)) throw new Error('Screen Studio refused the cut.');
        return { removedMs: Math.round(before - p.playbackDurationMs) };
      `, 60_000);
      if (json) return output({ success: true, removed: fillers.length, removedMs: result.removedMs }, true);
      return console.log(`Removed ${fillers.length} filler words (${formatMs(result.removedMs)}).`);
    }
    const result = await evaluate<{ verbatim: boolean; fillers: Token[]; removedMs?: number }>(cmd, `${CONTROLLER}
      var fillers = ctrl.presentFillerTokens.map(function (t) { return ss.tokenInfo(ctrl, t); });
      var result = { verbatim: ctrl.isVerbatimTranscript, fillers: fillers };
      ${opts.remove ? `ss.flush(p); var before = p.playbackDurationMs; ctrl.removeAllFillerWords(); result.removedMs = Math.round(before - p.playbackDurationMs);` : ""}
      return result;
    `, 60_000);
    if (json) return output(result, true);
    if (!result.verbatim) console.log("This transcript was not generated verbatim, so it may omit filler words. Regenerate with: screenstudio transcript generate --engine elevenlabs --verbatim");
    if (opts.remove) return console.log(`Removed ${result.fillers.length} filler words (${formatMs(result.removedMs ?? 0)}).`);
    if (!result.fillers.length) console.log("No filler words found. For non-English transcripts, try --language (e.g. --language es).");
    table(["Token", "Time", "Word"], result.fillers.map(t => [String(t.index), formatTime(t.playbackStartMs ?? 0), t.text]));
  });

const transcriptPauses = new Command("pauses")
  .description("List long pauses or shorten them all with --tighten (keeps a natural breath)")
  .option("--tighten", "Shorten every long pause")
  .action(async (opts, cmd) => {
    const result = await evaluate<{ pauses: Token[]; removedMs?: number }>(cmd, `${CONTROLLER}
      var result = { pauses: ctrl.tightenablePauseTokens.map(function (t) { return ss.tokenInfo(ctrl, t); }) };
      ${opts.tighten ? `ss.flush(p); var before = p.playbackDurationMs; ctrl.tightenAllPauses(); result.removedMs = Math.round(before - p.playbackDurationMs);` : ""}
      return result;
    `, 60_000);
    if (globals(cmd).json) return output(result, true);
    if (opts.tighten) return console.log(`Tightened ${result.pauses.length} pauses (${formatMs(result.removedMs ?? 0)} removed).`);
    table(["Token", "Time", "Pause"], result.pauses.map(t => [String(t.index), formatTime(t.playbackStartMs ?? 0), `${((t.sourceEndMs - t.sourceStartMs) / 1000).toFixed(1)}s`]));
  });

const transcriptGenerate = new Command("generate")
  .description("Generate (or regenerate) the transcript. Replaces the current transcript and its text corrections.")
  .addOption(new Option("--engine <engine>", "whisper (local), system (Apple Speech) or elevenlabs (cloud)").choices(["whisper", "system", "elevenlabs"]))
  .option("--language <code>", "Whisper language, e.g. es, en or auto")
  .addOption(new Option("--model <model>", "Whisper model").choices(["base", "small", "medium"]))
  .option("--prompt <text>", "Whisper prompt (vocabulary and style hints)")
  .option("--locale <locale>", "Apple Speech or ElevenLabs locale, e.g. es-ES")
  .option("--keyterms <terms>", "ElevenLabs key terms, comma separated")
  .option("--verbatim", "ElevenLabs: keep filler words so they can be removed")
  .option("--timeout <seconds>", "Give up waiting after this many seconds", "1800")
  .action(async (opts, cmd) => {
    const overrides: Record<string, unknown> = {};
    if (opts.language) overrides.language = opts.language;
    if (opts.model) overrides.model = opts.model;
    if (opts.prompt !== undefined) overrides.prompt = opts.prompt;
    if (opts.locale) overrides.locale = opts.locale;
    if (opts.keyterms !== undefined) overrides.keyterms = String(opts.keyterms).split(",").map((t: string) => t.trim()).filter(Boolean);
    if (opts.verbatim) overrides.verbatim = true;
    const defaults: Record<string, Record<string, unknown>> = {
      whisper: { type: "whisper", language: "auto", model: "small", prompt: "" },
      system: { type: "system" },
      elevenlabs: { type: "elevenlabs" },
    };
    const timeoutMs = numberValue(opts.timeout, "Timeout", 1) * 1000;
    const result = await evaluate<Record<string, unknown>>(cmd, `
      var p = ss.project(), ctrl = await ss.transcriptEditor(ss.editor(p), { allowMissing: true });
      if (!ctrl.client.canGenerate) throw new Error('This recording has no microphone audio to transcribe.');
      var engine = ${JSON.stringify(opts.engine ?? null)}, current = ctrl.client.currentGenerator;
      var base = engine ? (current && current.type === engine ? current : ${JSON.stringify(defaults)}[engine]) : current;
      if (!base) throw new Error('This project has no transcript yet. Pass --engine whisper, system or elevenlabs.');
      var generator = Object.assign({}, base, ${JSON.stringify(overrides)});
      if (generator.type === 'system' && !generator.locale) throw new Error('Apple Speech needs --locale, e.g. es-ES.');
      var ok = await ctrl.client.generate(generator);
      return { success: !!ok, generator: generator, words: ctrl.client.transcript.length };
    `, timeoutMs);
    output(result, globals(cmd).json);
  });

const transcriptSrt = new Command("srt")
  .description("Export the captions as SRT, with the video's cuts applied")
  .argument("<path>", "Output .srt file")
  .action(async (path, _opts, cmd) => {
    const outputPath = resolve(path);
    output(await evaluate(cmd, `${CONTROLLER}
      var resolver = p.scene.resolver, showLabels = p.captionsConfig.showSoundLabels;
      var words = ctrl.client.transcript.filter(function (w) {
        if (w.isHidden || (!showLabels && w.type === 'sound-label')) return false;
        return resolver.getIsSourceRangePresent([w.startMs, w.endMs]);
      }).map(function (w, i) {
        return { index: i, startMs: resolver.sourceToPlaybackTime(w.startMs), endMs: resolver.sourceToPlaybackTime(w.endMs), text: w.text.trim() };
      });
      await bridge.client.mutation('captions.exportTranscriptAsSRT', { transcript: words, outputPath: ${JSON.stringify(outputPath)} });
      return { success: true, path: ${JSON.stringify(outputPath)}, words: words.length };
    `, 60_000), globals(cmd).json);
  });

export const transcriptCommand = new Command("transcript")
  .description("Edit the video by its transcript: cut words, remove fillers and pauses, fix captions")
  .addCommand(transcriptStatus)
  .addCommand(transcriptShow)
  .addCommand(transcriptText)
  .addCommand(transcriptApply)
  .addCommand(transcriptEdit)
  .addCommand(transcriptCut)
  .addCommand(hideCommand("hide", true, "Hide words from the captions only (like ⌘⌫); the video is unchanged"))
  .addCommand(hideCommand("unhide", false, "Show hidden words in the captions again"))
  .addCommand(transcriptRestore)
  .addCommand(transcriptFix)
  .addCommand(transcriptFillers)
  .addCommand(transcriptPauses)
  .addCommand(transcriptGenerate)
  .addCommand(transcriptSrt);
