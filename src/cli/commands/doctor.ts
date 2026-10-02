import { Command } from "commander";
import { evaluate, globals } from "../context.js";
import { output, table } from "../format.js";

export const AUDITED_VERSION = "4.0.1-4897";
export const AUDITED_AT = "2026-10-02";

export const DOCTOR_EXPRESSION = `
  var version = typeof electronEnv !== 'undefined' ? electronEnv.APP_VERSION : null;
  var check = function (fn) { try { return !!fn(); } catch (e) { return false; } };
  var p = null, ed = null;
  try { p = ss.project(); } catch (e) { /* Project checks need an open project. */ }
  try { ed = p && ss.editor(p); } catch (e) { /* Editor checks need its window. */ }
  var collection = function (c) {
    return !!c && Array.isArray(c.all) && ['add', 'get', 'remove', 'splitAt', 'canSplitAt', 'findAt', 'removeAll'].every(function (m) { return typeof c[m] === 'function'; });
  };
  var actionCount = 0;
  var checks = {
    projectRegistry: check(function () { return ss.projects(); }),
    bridge: typeof bridge !== 'undefined' && typeof bridge.client?.query === 'function' && typeof bridge.client?.mutation === 'function',
    actions: check(function () { actionCount = ss.actionManager().actions.length; return actionCount > 0; }),
    editor: p ? !!ed : null,
    slices: p ? check(function () { return collection(p.scene.slices) && typeof p.scene.slices.at(0).update === 'function'; }) : null,
    zooms: p ? check(function () { return collection(p.scene.zooms); }) : null,
    masks: p ? check(function () { return collection(p.scene.masks); }) : null,
    layouts: p ? check(function () { return collection(p.scene.layouts); }) : null,
    config: p ? check(function () { return typeof p.updateConfig === 'function' && !!p.projectConfig.serialize().captions; }) : null,
    undo: p ? check(function () { return typeof p.history.undo === 'function' && typeof p.history.historyBuffer.flush === 'function'; }) : null,
    save: ed ? check(function () { return ss.action('saveProject'); }) : null,
    seek: ed ? typeof ed.playback.goTo === 'function' : null,
    frameExport: ed ? typeof ed.animation?.exportImage === 'function' : null,
    export: ed ? typeof ed.exportManager.startExport === 'function' : null,
    transcriptEditor: null,
  };
  var transcript = null;
  if (ed) {
    try {
      var ctrl = await ss.transcriptEditor(ed, { allowMissing: true });
      checks.transcriptEditor = ['deleteTokens', 'restoreTarget', 'setCoveredWordsHidden', 'applyWordRangeReplacement',
        'removeAllFillerWords', 'tightenAllPauses'].every(function (m) { return typeof ctrl[m] === 'function'; });
      transcript = ctrl.isTranscriptReady ? 'ready' : ctrl.client.canGenerate ? 'missing' : 'no audio';
    } catch (e) { checks.transcriptEditor = false; }
  }
  return { version: version, auditedVersion: ${JSON.stringify(AUDITED_VERSION)}, auditedAt: ${JSON.stringify(AUDITED_AT)},
    matchesAuditedVersion: version === ${JSON.stringify(AUDITED_VERSION)}, projectOpen: !!p, editorOpen: !!ed,
    actionCount: actionCount, transcript: transcript, checks: checks };
`;

export const doctorCommand = new Command("doctor")
  .description("Inspect runtime capabilities against the audited Screen Studio build")
  .action(async (_opts, cmd) => {
    const result = await evaluate<{
      version: string | null; matchesAuditedVersion: boolean; projectOpen: boolean; editorOpen: boolean;
      actionCount: number; transcript: string | null; checks: Record<string, boolean | null>;
    }>(cmd, DOCTOR_EXPRESSION, 60_000);
    if (globals(cmd).json) output(result, true);
    else {
      console.log(`Screen Studio ${result.version || "unknown"} | Audited: ${AUDITED_VERSION} (${AUDITED_AT})`);
      if (!result.matchesAuditedVersion) console.log("This build differs from the audited version; matching capabilities do not guarantee compatibility.");
      if (!result.projectOpen) console.log("Open a project to check editing capabilities.");
      else if (!result.editorOpen) console.log("Open the project's editor window to check playback, export and transcript editing.");
      table(["Capability", "Available"], Object.entries(result.checks).map(([key, value]) => [
        key, value === null ? (result.projectOpen ? "needs editor" : "needs project") : value ? "yes" : "no",
      ]));
      console.log(`${result.actionCount} app actions.${result.transcript ? ` Transcript: ${result.transcript}.` : ""} See docs/compatibility.md for feature coverage.`);
    }
    if (Object.values(result.checks).some(value => value === false)) process.exitCode = 1;
  });
