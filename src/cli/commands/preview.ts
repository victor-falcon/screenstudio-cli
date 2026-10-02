import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { evaluate, globals } from "../context.js";
import { output } from "../format.js";
import { numberValue } from "../validation.js";
import { seekExpression, seekTarget } from "./seek.js";

export const previewCommand = new Command("preview")
  .description("Render the current frame with Screen Studio's own renderer and save it as PNG")
  .option("-o, --output <path>", "Output file path", "/tmp/screenstudio-preview.png")
  .option("--at <ms>", "Seek to a playback time first (ms, 'start', or 'end')")
  .option("--source", "Interpret --at on the recording (source) timeline")
  .option("--height <px>", "Image height in pixels", "1080")
  .option("--open", "Open the image after saving")
  .action(async (opts, cmd) => {
    const height = numberValue(opts.height, "Height", 100, 4320);
    const result = await evaluate<{ data: string; playbackMs: number }>(cmd, `
      var p = ss.project(), ed = ss.editor(p);
      ${opts.at === undefined ? "" : seekExpression(seekTarget(opts.at), !!opts.source)}
      if (typeof ed.animation?.exportImage !== 'function') throw new Error('Frame export is unavailable in this Screen Studio build.');
      var blob = await ed.animation.exportImage({ heightPx: ${Math.round(height)} });
      var bytes = new Uint8Array(await blob.arrayBuffer()), binary = '';
      for (var i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { data: btoa(binary), playbackMs: Math.round(ed.playback.headTime) };
    `, 60_000);
    if (!result?.data) throw new Error("Screen Studio did not return a preview image.");
    const path = resolve(opts.output);
    writeFileSync(path, Buffer.from(result.data, "base64"));
    if (globals(cmd).json) output({ success: true, path, playbackMs: result.playbackMs }, true);
    else console.log(`Preview at ${result.playbackMs}ms saved to ${path}`);
    if (opts.open) execFileSync("open", [path]);
  });
