import { Command } from "commander";
import { evaluate, globals } from "../context.js";
import { output } from "../format.js";
import { numberValue } from "../validation.js";

// "start", "end" or milliseconds. --source interprets the time on the recording timeline.
export function seekTarget(value: string): number | "start" | "end" {
  return value === "start" || value === "end" ? value : numberValue(value, "Time");
}

// Moves the editor's playhead and waits until the preview frame is ready.
export function seekExpression(target: number | "start" | "end", source = false): string {
  const time = target === "start" ? "0" : target === "end" ? (source ? "p.sourceDurationMs" : "p.playbackDurationMs") : String(target);
  return `
    var targetMs = ${time};
    if (targetMs < 0 || targetMs > ${source ? "p.sourceDurationMs" : "p.playbackDurationMs"}) throw new Error('Seek time is outside the ${source ? "recording" : "project"}.');
    ${source ? `
      if (!p.scene.resolver.getIsSourceTimePresent?.(targetMs)) throw new Error('Source time ' + targetMs + 'ms was cut from the video.');
      ed.playback.goToSourceTime(targetMs);
    ` : "ed.playback.goTo(targetMs);"}
    if (typeof ed.animation?.waitForFrameReady === 'function') await ed.animation.waitForFrameReady();
  `;
}

export const seekCommand = new Command("seek")
  .description("Move the playhead to a playback time in ms ('start' or 'end')")
  .argument("<timeMs>", "Playback time in milliseconds (or 'start' / 'end')")
  .option("--source", "Interpret the time on the recording (source) timeline")
  .action(async (timeArg, opts, cmd) => {
    const result = await evaluate<{ playbackMs: number; sourceMs: number }>(cmd, `
      var p = ss.project(), ed = ss.editor(p);
      ${seekExpression(seekTarget(timeArg), !!opts.source)}
      return { success: true, playbackMs: Math.round(ed.playback.headTime), sourceMs: Math.round(ed.playback.headSourceTime) };
    `);
    if (globals(cmd).json) output(result, true);
    else console.log(`Seeked to ${result.playbackMs}ms (source ${result.sourceMs}ms)`);
  });
