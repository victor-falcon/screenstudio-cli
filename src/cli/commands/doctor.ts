import { PROJECT_LOOKUP } from "../validation.js";
import { Command } from "commander";
import { withClient } from "../../cdp/client.js";
import { output, table } from "../format.js";

export const AUDITED_VERSION = "3.7.5-4595";
export const AUDITED_AT = "2026-09-16";

export const DOCTOR_EXPRESSION = `
  ${PROJECT_LOOKUP}
  var scene = p?.scenes?.[0];
  var config = p?.config || {};
  var version = typeof electronEnv !== 'undefined' ? electronEnv.APP_VERSION : null;
  var bridgeAvailable = typeof bridge !== 'undefined' && typeof bridge.client?.query === 'function' &&
    typeof bridge.client?.mutation === 'function';
  var checks = {
    projectRegistry: !!window.$projects,
    bridge: bridgeAvailable,
    configEditing: p ? typeof p.updateConfig === 'function' : null,
    timelineEditing: p ? typeof scene?.update === 'function' && Array.isArray(scene?.slices) : null,
    zooms: p ? Array.isArray(scene?.zoomRanges) : null,
    masks: p ? typeof scene?.addMask === 'function' && typeof scene?.updateMask === 'function' : null,
    projectSave: p ? !!p.rawData && bridgeAvailable : null,
    undo: p ? typeof p.history?.undo === 'function' && typeof p.history?.redo === 'function' : null,
    backgroundAudio: p ? 'backgroundAudioFileName' in config : null,
    microphoneEnhancement: p ? 'improveMicrophoneAudio' in config : null,
    microphoneStereo: p ? 'microphoneInStereoMode' in config : null,
    externalDeviceAudio: p ? 'muteExternalDeviceAudio' in config : null,
    clickSounds: p ? 'clickSoundEffect' in config : null,
    captionsVisibility: p ? 'showTranscript' in config : null,
    customCursors: p ? 'cursorSet' in config : null,
    deviceMockups: p ? 'deviceFrameKey' in config : null,
    cameraLayouts: p ? Array.isArray(scene?.layouts) : null,
  };
  return { version: version, auditedVersion: ${JSON.stringify(AUDITED_VERSION)},
    auditedAt: ${JSON.stringify(AUDITED_AT)}, matchesAuditedVersion: version === ${JSON.stringify(AUDITED_VERSION)},
    projectOpen: !!p, configKeyCount: Object.keys(config).length, checks: checks };
`;

export const doctorCommand = new Command("doctor")
  .description("Inspect runtime capabilities against the audited Screen Studio build")
  .action(async (_opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    const result = await withClient(Number(opts.port), client => client.evaluate<{
      version: string | null; matchesAuditedVersion: boolean; projectOpen: boolean;
      configKeyCount: number; checks: Record<string, boolean | null>;
    }>(DOCTOR_EXPRESSION));
    if (opts.json) output(result, true);
    else {
      console.log(`Screen Studio ${result.version || "unknown"} | Audited: ${AUDITED_VERSION} (${AUDITED_AT})`);
      if (!result.matchesAuditedVersion) console.log("This build differs from the audited version; matching capabilities do not guarantee compatibility.");
      if (!result.projectOpen) console.log("Open a project to check editing capabilities.");
      table(["Capability", "Available"], Object.entries(result.checks).map(([key, value]) => [
        key, value === null ? "needs project" : value ? "yes" : "no",
      ]));
      console.log(`${result.configKeyCount} project config keys. See docs/compatibility.md for feature coverage.`);
    }
    const required = ["projectRegistry", "bridge", "configEditing", "timelineEditing", "zooms", "masks", "projectSave", "undo"];
    if (required.some(key => result.checks[key] === false)) process.exitCode = 1;
  });
