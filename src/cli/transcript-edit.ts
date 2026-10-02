import { diffWords } from "./word-diff.js";

// A transcript token as returned by the runtime's ss.tokenInfo().
export interface Token {
  index: number;
  kind: "word" | "gap";
  text: string;
  sourceStartMs: number;
  sourceEndMs: number;
  playbackStartMs: number | null;
  present: boolean;
  hidden: boolean;
  filler: number | null;
}

export interface Paragraph {
  start: number;
  end: number;
}

export interface TranscriptEditPlan {
  // Inclusive token index ranges to cut from the video.
  cuts: Array<[number, number]>;
  cutText: string[];
  // Inclusive token index ranges whose text is replaced.
  corrections: Array<{ start: number; end: number; from: string; to: string }>;
}

// Words that appear in the video, i.e. the ones an edited text file can keep or delete.
export function editableWords(tokens: readonly Token[]): Token[] {
  return tokens.filter(t => t.kind === "word" && t.present && t.text.trim() !== "");
}

export function formatTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = (total % 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${seconds}`;
}

export function renderEditableTranscript(projectName: string, tokens: readonly Token[], paragraphs: readonly Paragraph[]): string {
  const lines = [
    `# Screen Studio transcript: ${projectName}`,
    "# Delete words, sentences or paragraphs to cut them from the video, or retype a word to",
    "# correct the captions. Then run: screenstudio transcript apply <this file> [--dry-run]",
    "# Lines starting with # are ignored. Words already cut from the video are not listed.",
  ];
  for (const [number, paragraph] of paragraphs.entries()) {
    const words = editableWords(tokens.slice(paragraph.start, paragraph.end + 1));
    if (!words.length) continue;
    lines.push("", `# ¶${number + 1} ${formatTime(words[0].playbackStartMs ?? 0)}`, words.map(w => w.text.trim()).join(" "));
  }
  return lines.join("\n") + "\n";
}

export function parseEditedTranscript(text: string): string[] {
  return text.split(/\r?\n/)
    .filter(line => !line.trim().startsWith("#"))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.normalize("NFC"));
}

const similarityKey = (text: string) => text.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "");

// 2·LCS / (|a| + |b|) over letters and digits: 1 for equal text, 0 for nothing in common.
function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const row = new Array<number>(b.length + 1).fill(0);
  for (const char of a) {
    let previous = 0;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = char === b[j - 1] ? previous + 1 : Math.max(row[j], row[j - 1]);
      previous = saved;
    }
  }
  return (2 * row[b.length]) / (a.length + b.length);
}

// In a stretch where words were both deleted and typed, the typed words replace the run of
// deleted words they resemble most (a retyped or merged word); the others were deleted.
// When nothing resembles them, the whole stretch was rewritten, which never cuts.
function replacementWindow(deleted: readonly string[], typed: readonly string[]): [number, number] {
  const target = similarityKey(typed.join(""));
  let best: [number, number] = [0, deleted.length], bestScore = 0;
  for (let i = 0; i < deleted.length; i++) {
    for (let j = i + 1; j <= Math.min(deleted.length, i + typed.length + 3); j++) {
      const score = similarity(similarityKey(deleted.slice(i, j).join("")), target);
      if (score > bestScore + 1e-9) { best = [i, j]; bestScore = score; }
    }
  }
  // Typos, merged or split words and punctuation changes score 0.8 or more.
  return bestScore >= 0.7 ? best : [0, deleted.length];
}

// Diffs the edited words against the words in the video. Deleting words, with nothing
// typed in their place, cuts them from the video. Retyped, merged, split or inserted words
// correct the captions of the words they replace, like typing in the app's transcript editor.
export function planTranscriptEdit(tokens: readonly Token[], edited: readonly string[]): TranscriptEditPlan {
  const words = editableWords(tokens);
  const parts: Array<{ token: number; text: string }> = [];
  const tokenParts: Array<[number, number]> = [];
  words.forEach((w, position) => {
    const first = parts.length;
    for (const part of w.text.trim().split(/\s+/)) parts.push({ token: position, text: part.normalize("NFC") });
    tokenParts.push([first, parts.length - 1]);
  });

  // What happens to each part of the original text.
  const state: Array<"keep" | "delete" | "replace"> = parts.map(() => "keep");
  const keptText = parts.map(p => p.text);
  const after: string[][] = parts.map(() => []);
  const replacementAt = new Map<number, string[]>();
  const leading: string[] = [];
  const group = new Array<number>(parts.length).fill(-1);
  let groups = 0;

  const ops = diffWords(parts.map(p => p.text), edited);
  let lastKept: number | null = null;
  for (let i = 0; i < ops.length;) {
    const op = ops[i];
    if (op.op === "equal") { keptText[op.a] = edited[op.b]; lastKept = op.a; i++; continue; }
    const deleted: number[] = [], typed: string[] = [];
    for (; i < ops.length && ops[i].op !== "equal"; i++) {
      const o = ops[i];
      if (o.op === "delete") deleted.push(o.a); else if (o.op === "insert") typed.push(edited[o.b]);
    }
    deleted.forEach(k => { state[k] = "delete"; });
    if (!typed.length) continue;
    if (!deleted.length) {
      // Pure insertion: it extends the word before it, or the first word.
      if (lastKept === null) leading.push(...typed);
      else after[lastKept].push(...typed);
      continue;
    }
    const [from, to] = replacementWindow(deleted.map(k => parts[k].text), typed);
    const id = groups++;
    for (const k of deleted.slice(from, to)) { state[k] = "replace"; group[k] = id; }
    replacementAt.set(deleted[from], typed);
  }

  const textOf = (position: number) => {
    const [first, last] = tokenParts[position], out: string[] = position === 0 ? [...leading] : [];
    for (let k = first; k <= last; k++) {
      if (state[k] === "keep") out.push(keptText[k]);
      else if (replacementAt.has(k)) out.push(...replacementAt.get(k)!);
      out.push(...after[k]);
    }
    return out;
  };
  const groupsOf = (position: number) => {
    const [first, last] = tokenParts[position], ids = new Set<number>();
    for (let k = first; k <= last; k++) if (group[k] >= 0) ids.add(group[k]);
    return ids;
  };

  const cuts: Array<[number, number]> = [], cutText: string[] = [];
  const corrections: TranscriptEditPlan["corrections"] = [];
  let run: Token[] = [];
  const closeRun = () => {
    if (!run.length) return;
    cuts.push([run[0].index, run[run.length - 1].index]);
    cutText.push(run.map(w => w.text.trim()).join(" "));
    run = [];
  };
  for (let position = 0; position < words.length; position++) {
    const ids = groupsOf(position);
    if (ids.size) {
      // Extend over every following word rewritten by the same replacements.
      let end = position;
      while (end + 1 < words.length && [...groupsOf(end + 1)].some(id => ids.has(id))) {
        groupsOf(end + 1).forEach(id => ids.add(id));
        end++;
      }
      closeRun();
      const from = words.slice(position, end + 1).map(w => w.text.trim()).join(" ");
      const to = words.slice(position, end + 1).flatMap((_, k) => textOf(position + k)).join(" ");
      if (to !== from) corrections.push({ start: words[position].index, end: words[end].index, from, to });
      position = end;
      continue;
    }
    const [first, last] = tokenParts[position];
    const w = words[position];
    if (state.slice(first, last + 1).every(s => s === "delete")) { run.push(w); continue; }
    closeRun();
    const text = textOf(position).join(" ");
    if (text !== w.text.trim()) corrections.push({ start: w.index, end: w.index, from: w.text.trim(), to: text });
  }
  closeRun();
  return { cuts, cutText, corrections };
}

// Parses "12", "12-40" and comma/space separated lists into inclusive index ranges.
export function parseRanges(values: readonly string[], max: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const value of values.flatMap(v => v.split(",")).map(v => v.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(value);
    if (!match) throw new Error(`Invalid token range: ${value}. Use an index like 12 or a range like 12-40.`);
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (end < start) throw new Error(`Invalid token range: ${value}. The end must not precede the start.`);
    if (end > max) throw new Error(`Token range ${value} is out of range (0-${max}).`);
    ranges.push([start, end]);
  }
  return ranges;
}

const normalize = (text: string) => text.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}'-]+/gu, "");

// Finds every occurrence of a phrase among the given words, ignoring case and punctuation.
export function findPhrase(words: readonly Token[], phrase: string): Array<[number, number]> {
  const needle = phrase.split(/\s+/).map(normalize).filter(Boolean);
  if (!needle.length) throw new Error("The text to find is empty.");
  const haystack = words.map(w => w.text.trim().split(/\s+/).map(normalize));
  const flat: Array<{ word: number; text: string }> = [];
  haystack.forEach((parts, word) => parts.forEach(text => { if (text) flat.push({ word, text }); }));
  const matches: Array<[number, number]> = [];
  for (let i = 0; i + needle.length <= flat.length; i++) {
    if (needle.every((n, j) => flat[i + j].text === n)) {
      matches.push([words[flat[i].word].index, words[flat[i + needle.length - 1].word].index]);
      i += needle.length - 1;
    }
  }
  return matches;
}
