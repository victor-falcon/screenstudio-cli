import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { withClient } from "../../cdp/client.js";
import { findPreviewPage } from "../../cdp/page-finder.js";
import { FIND_SEEK_FN, SEEK_TO_TIME, INIT_PIXI, FORCE_RENDER, REFRESH_MEDIA } from "./seek.js";
import { numberValue, PROJECT } from "../validation.js";
import { output } from "../format.js";

export const previewCommand = new Command("preview")
  .description("Screenshot the video preview canvas only")
  .option("-o, --output <path>", "Output file path", "/tmp/screenstudio-preview.png")
  .option("--at <ms>", "Seek to playback time before capturing (ms, 'start', or 'end')")
  .option("--open", "Open the image after saving")
  .action(async (opts, cmd) => {
    const global = cmd.optsWithGlobals();
    const port = Number(global.port);
    const timeMs = opts.at === undefined ? undefined : opts.at === "start" ? 0 :
      opts.at === "end" ? -1 : numberValue(opts.at, "Playback time");

    const result = await withClient(port, async main => {
      await main.evaluate(`${PROJECT}
        ${timeMs === undefined ? "" : `
          var targetMs = ${timeMs === -1 ? "p.playbackDurationMs" : timeMs};
          if (targetMs > p.playbackDurationMs) throw new Error('Seek time extends beyond the project.');
        `}
        ${FIND_SEEK_FN}
        ${timeMs === undefined ? "" : SEEK_TO_TIME}
      `);

      const wsUrl = await findPreviewPage(port);
      return withClient(port, async preview => {
        await preview.evaluate(`${INIT_PIXI}
          if (!window.__pixiComponent) throw new Error('Could not find the preview renderer in this Screen Studio build.');
          ${FORCE_RENDER}
        `);
        // The first render starts screen/webcam frame requests. Waiting before
        // it can observe an empty readiness queue and capture an old frame.
        await main.evaluate(`await window.__seekPlayback?.waitForFrameReady();`);
        await preview.evaluate(`${INIT_PIXI} ${REFRESH_MEDIA} ${FORCE_RENDER}`);

        const { root } = await preview.request<{ root: { nodeId: number } }>("DOM.getDocument");
        const { nodeId } = await preview.request<{ nodeId: number }>("DOM.querySelector", {
          nodeId: root.nodeId, selector: "canvas",
        });
        if (!nodeId) throw new Error("Could not find the preview canvas.");
        const { model } = await preview.request<{ model: { content: number[] } }>("DOM.getBoxModel", { nodeId });
        const box = model.content;
        const x = box[0], y = box[1], width = box[2] - x, height = box[5] - y;
        if (!(width > 0 && height > 0)) throw new Error("The preview canvas is not visible.");
        const { data } = await preview.request<{ data: string }>("Page.captureScreenshot", {
          format: "png", clip: { x, y, width, height, scale: 2 },
        });
        if (!data) throw new Error("Screen Studio did not return a preview image.");
        return data;
      }, wsUrl);
    });

    writeFileSync(opts.output, Buffer.from(result, "base64"));
    if (global.json) output({ success: true, path: opts.output }, true);
    else console.log(`Preview saved to ${opts.output}`);
    if (opts.open) execFileSync("open", [opts.output]);
  });
