import { Command, Option } from "commander";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withClient } from "../../cdp/client.js";
import { runtimePrelude } from "../../cdp/runtime.js";
import { evaluate, globals } from "../context.js";
import { output } from "../format.js";
import { indexValue, numberValue } from "../validation.js";

// Allowed values, as offered by Screen Studio 4's export dialog.
export const EXPORT_OPTIONS = {
  mp4: { fps: [60, 50, 30, 25, 24, 20, 10], quality: ["studio", "social-media", "web-high", "web-low"], height: [720, 1080, 2160] },
  gif: { fps: [50, 30, 25, 20, 15, 10], quality: ["studio", "social-media"], height: [480, 720, 1080] },
} as const;

interface ExportStatus {
  inProgress: boolean;
  progress: unknown;
}

const STATUS = `
  var em = ss.editor().exportManager;
  return { inProgress: em.isExportInProgress, progress: em.exportProgress ?? null };
`;

// Screen Studio writes clipboard exports here (Electron's temp path) and does not report
// the file name, so the CLI looks for the file that appears during the export.
const CLIPBOARD_EXPORTS = join(tmpdir(), "Screen Studio", "Clipboard Exports");

function clipboardExports(): Map<string, number> {
  const files = new Map<string, number>();
  if (!existsSync(CLIPBOARD_EXPORTS)) return files;
  for (const name of readdirSync(CLIPBOARD_EXPORTS)) {
    if (/\.(mp4|gif)$/i.test(name)) files.set(join(CLIPBOARD_EXPORTS, name), statSync(join(CLIPBOARD_EXPORTS, name)).mtimeMs);
  }
  return files;
}

function progressPercent(progress: unknown): string | null {
  const value = typeof progress === "number" ? progress :
    progress && typeof progress === "object" ? Number((progress as Record<string, unknown>).progress ?? (progress as Record<string, unknown>).progress01) : NaN;
  return Number.isFinite(value) ? `${Math.round(value * (value <= 1 ? 100 : 1))}%` : null;
}

function resolutionValue(value: string): number {
  if (value.toLowerCase() === "4k") return 2160;
  return indexValue(value.replace(/p$/i, ""), "Resolution");
}

export const exportCommand = new Command("export")
  .description("Export the project with your current export settings, overridden by the options")
  .addOption(new Option("--format <format>", "Output format").choices(["mp4", "gif"]))
  .option("--fps <n>", "Frames per second (mp4: 60, 50, 30, 25, 24, 20, 10)")
  .option("--resolution <height>", "Output height: 720, 1080, 2160 or 4k (gif: 480, 720, 1080)")
  .addOption(new Option("--quality <quality>", "Quality preset").choices(["studio", "social-media", "web-high", "web-low"]))
  .addOption(new Option("--codec <codec>", "MP4 codec").choices(["h264", "h265"]))
  .option("--no-loop", "Play GIFs once")
  .option("-o, --output <path>", "Save to this path without a dialog (exports through the clipboard target, which also copies the video to the clipboard)")
  .option("--clipboard", "Export to the clipboard")
  .option("--wait", "Wait for the export to finish and print the output path")
  .option("--timeout <seconds>", "Give up waiting after this many seconds")
  .option("--picker", "Only open Screen Studio's export dialog")
  .action(async (opts, cmd) => {
    const { port, project, json } = globals(cmd);
    if (opts.picker) {
      return output(await evaluate(cmd, `
        var em = ss.editor().exportManager;
        if (em.isExportInProgress) throw new Error('An export is already in progress.');
        await em.openPicker();
        if (!em.isPickerOpened) throw new Error('Screen Studio did not open the export dialog. Check the app for a prompt.');
        return { success: true, message: 'Opened export dialog' };
      `), json);
    }
    if (opts.output && opts.clipboard) throw new Error("Choose --output or --clipboard.");
    const overrides: Record<string, unknown> = {};
    if (opts.format) overrides.format = opts.format;
    if (opts.fps !== undefined) overrides.fps = indexValue(opts.fps, "FPS");
    if (opts.resolution !== undefined) overrides.height = resolutionValue(opts.resolution);
    if (opts.quality) overrides.quality = opts.quality;
    if (opts.codec) overrides.mp4Codec = opts.codec;
    if (opts.loop === false) overrides.gifDisableLoop = true;
    const target = opts.output || opts.clipboard ? "clipboard" : "file";
    const destination = opts.output ? resolve(opts.output) : null;
    const timeoutMs = opts.timeout === undefined ? Infinity : numberValue(opts.timeout, "Timeout", 1) * 1000;

    const before = clipboardExports();
    await withClient(port, async client => {
      const run = <T>(body: string) => client.evaluate<T>(`${runtimePrelude(project)}\n${body}`);
      const started = await run<{ settings: Record<string, unknown> }>(`
        var p = ss.project(), ed = ss.editor(p), em = ed.exportManager;
        if (em.isExportInProgress) throw new Error('An export is already in progress.');
        var allowed = ${JSON.stringify(EXPORT_OPTIONS)}, overrides = ${JSON.stringify(overrides)};
        var stored = function (key) {
          try { return JSON.parse(localStorage.getItem('export-settings-preference-' + key)).json; } catch (e) { return null; }
        };
        var format = overrides.format ?? stored('type-export-settings') ?? 'mp4';
        if (!allowed[format]) throw new Error('Unsupported export format: ' + format);
        var defaults = format === 'gif' ? { fps: 15, quality: 'studio', height: 480, gifDisableLoop: false }
          : { fps: 60, quality: 'social-media', height: 1080, mp4Codec: 'h264' };
        var settings = Object.assign(defaults, stored(format + '-export-settings'), overrides, { format: format });
        for (var key of ['fps', 'quality', 'height']) {
          if (!allowed[format][key].includes(settings[key])) {
            throw new Error('Invalid ' + format + ' ' + key + ': ' + settings[key] + '. Use one of: ' + allowed[format][key].join(', '));
          }
        }
        if (format === 'mp4' && !['h264', 'h265'].includes(settings.mp4Codec)) settings.mp4Codec = 'h264';
        var exportId = await em.startExport(Object.assign({}, settings, {
          target: ${JSON.stringify(target)}, projectPath: p.path, projectData: p.serialize(),
        }));
        if (!exportId && !em.isExportInProgress) throw new Error('Screen Studio did not start the export. Check the app for a prompt.');
        return { settings: settings };
      `);

      if (!opts.wait && !destination) {
        output({ success: true, target, settings: started.settings,
          message: target === "file" ? "Export started. Screen Studio asks where to save it." : "Export to clipboard started." }, json);
        return;
      }

      let lastLine = "", lastProgress: string | null = null;
      const startedAt = Date.now();
      for (;;) {
        const status = await run<ExportStatus>(STATUS);
        if (!status.inProgress) break;
        lastProgress = progressPercent(status.progress) ?? lastProgress;
        if (!json && lastProgress && lastProgress !== lastLine) { process.stderr.write(`\rExporting... ${lastProgress}   `); lastLine = lastProgress; }
        if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for the export. It continues in Screen Studio.");
        await new Promise(r => setTimeout(r, 250));
      }
      if (!json && lastLine) process.stderr.write("\n");
      if (target === "file") {
        // The save dialog decides the path, which Screen Studio does not report.
        output({ success: true, target, settings: started.settings, message: "Export finished, unless it was cancelled in Screen Studio." }, json);
        return;
      }
      const created = [...clipboardExports()].filter(([file, mtime]) => before.get(file) !== mtime).sort((x, y) => y[1] - x[1]);
      if (!created.length) throw new Error("The export did not produce a file. It was cancelled or failed; check Screen Studio.");
      const exported = created[0][0];
      if (destination) copyFileSync(exported, destination);
      output({ success: true, target, settings: started.settings, path: destination ?? exported }, json);
    }, undefined, 120_000);
  });
