import { Command } from "commander";
import { evaluate, globals } from "../context.js";
import { output } from "../format.js";
import { indexValue, numberValue, timeRange } from "../validation.js";
import { printSliceTable } from "./state.js";

const SLICE_AT_INDEX = `
  var p = ss.project(), scene = ss.scene(p), index = INDEX;
  var slice = scene.slices.at(index);
  if (!slice) throw new Error('Slice index ' + index + ' out of range (0-' + (scene.slices.length - 1) + ')');
`;

function sliceAt(index: number): string {
  return SLICE_AT_INDEX.replace("INDEX", String(index));
}

const sliceList = new Command("list")
  .description("List all slices on the timeline")
  .action(async (_opts, cmd) => {
    const slices = await evaluate<Parameters<typeof printSliceTable>[0]>(cmd, `return ss.scene().slices.map(ss.sliceInfo);`);
    if (globals(cmd).json) output(slices, true);
    else printSliceTable(slices);
  });

const sliceSplit = new Command("split")
  .description("Split a slice at a source time (in ms)")
  .argument("<timeMs>", "Source time in milliseconds")
  .action(async (timeMs, _opts, cmd) => {
    const time = numberValue(timeMs, "Split time");
    output(await evaluate(cmd, `
      var scene = ss.scene(), time = ${time};
      if (!scene.slices.findAt(time)) throw new Error('No slice found at ' + time + 'ms');
      if (!scene.slices.canSplitAt(time)) throw new Error('Cannot split at ' + time + 'ms: both parts must last at least ' + scene.slices.minItemDurationMs + 'ms.');
      scene.slices.splitAt(time);
      return { success: true, sliceCount: scene.slices.length };
    `), globals(cmd).json);
  });

// Same outcome as cutting a range in the app: each overlapping slice is removed, trimmed,
// or split around the range. Parts shorter than the minimum slice duration are dropped.
export const REMOVE_SOURCE_RANGE = `
  function removeSourceRange(p, fromMs, toMs) {
    var slices = p.scene.slices, min = slices.minItemDurationMs;
    var overlapping = slices.filter(function (s) { return s.sourceStartMs < toMs && s.sourceEndMs > fromMs; });
    var covered = function (s) { return fromMs - s.sourceStartMs < min && s.sourceEndMs - toMs < min; };
    if (overlapping.length === slices.length && overlapping.every(covered)) throw new Error("Can't remove the entire video.");
    var before = p.playbackDurationMs;
    for (var s of overlapping.reverse()) {
      var keepHead = fromMs - s.sourceStartMs >= min, keepTail = s.sourceEndMs - toMs >= min;
      if (!keepHead && !keepTail) s.remove();
      else if (!keepHead) s.update({ sourceStartMs: toMs });
      else if (!keepTail) s.update({ sourceEndMs: fromMs });
      else { slices.splitAt(fromMs); slices.findNextAt(fromMs)?.update({ sourceStartMs: toMs }); }
    }
    return { affectedSlices: overlapping.length, removedMs: Math.round(before - p.playbackDurationMs) };
  }
`;

const sliceRemove = new Command("remove")
  .description("Remove a slice by index, or a source time range with --from/--to")
  .argument("[index]", "Slice index to remove")
  .option("--from <ms>", "Start of the source time range to remove")
  .option("--to <ms>", "End of the source time range to remove")
  .action(async (index, opts, cmd) => {
    const json = globals(cmd).json;
    const hasRange = opts.from !== undefined || opts.to !== undefined;
    if (hasRange && (opts.from === undefined || opts.to === undefined || index !== undefined)) {
      throw new Error("Provide either a slice index or both --from and --to.");
    }
    if (hasRange) {
      const fromMs = numberValue(opts.from, "Start time");
      const toMs = numberValue(opts.to, "End time");
      timeRange(fromMs, toMs);
      output(await evaluate(cmd, `${REMOVE_SOURCE_RANGE}
        var p = ss.project();
        if (${toMs} > p.sourceDurationMs) throw new Error('Removal range extends beyond the recording.');
        var result = removeSourceRange(p, ${fromMs}, ${toMs});
        return { success: true, removedMs: result.removedMs, remainingSlices: p.scene.slices.length,
          newDurationMs: Math.round(p.playbackDurationMs) };
      `), json);
    } else if (index !== undefined) {
      output(await evaluate(cmd, `${sliceAt(indexValue(index))}
        if (scene.slices.length === 1) throw new Error("Can't remove the only slice.");
        slice.remove();
        return { success: true, remainingSlices: scene.slices.length };
      `), json);
    } else {
      throw new Error("Provide a slice index or --from/--to range.");
    }
  });

const sliceSpeed = new Command("speed")
  .description("Set playback speed of one slice or all slices")
  .argument("<index>", "Slice index, or all")
  .argument("<speed>", "Speed multiplier (e.g. 2.0)")
  .action(async (index, speed, _opts, cmd) => {
    const idx = index === "all" ? null : indexValue(index);
    const spd = numberValue(speed, "Speed");
    if (spd <= 0 || !Number.isFinite(1 / spd)) throw new Error("Speed must be greater than zero with a finite time scale.");
    output(await evaluate(cmd, `
      var scene = ss.scene(), index = ${idx};
      if (index !== null && !scene.slices.at(index)) throw new Error('Slice index out of range: ' + index);
      var targets = index === null ? scene.slices.map(function (s) { return s; }) : [scene.slices.at(index)];
      targets.forEach(function (s) { s.update({ timeScale: 1 / ${spd} }); });
      return { success: true, index: index === null ? 'all' : index, speed: ${spd}, updated: targets.length };
    `), globals(cmd).json);
  });

const sliceMerge = new Command("merge")
  .description("Merge a slice with the next one")
  .argument("<index>", "Slice index to merge with next")
  .action(async (index, _opts, cmd) => {
    output(await evaluate(cmd, `${sliceAt(indexValue(index))}
      if (!slice.next) throw new Error('No next slice to merge.');
      slice.mergeWithNext();
      return { success: true, remainingSlices: scene.slices.length };
    `), globals(cmd).json);
  });

const sliceTrim = new Command("trim")
  .description("Adjust the start or end boundary of a slice")
  .argument("<index>", "Slice index")
  .option("--start <ms>", "New source start time in ms")
  .option("--end <ms>", "New source end time in ms")
  .action(async (index, opts, cmd) => {
    if (opts.start === undefined && opts.end === undefined) throw new Error("Provide --start and/or --end.");
    const updates: Record<string, number> = {};
    if (opts.start !== undefined) updates.sourceStartMs = numberValue(opts.start, "Start time");
    if (opts.end !== undefined) updates.sourceEndMs = numberValue(opts.end, "End time");
    output(await evaluate(cmd, `${sliceAt(indexValue(index))}
      var updates = ${JSON.stringify(updates)};
      var start = updates.sourceStartMs ?? slice.sourceStartMs, end = updates.sourceEndMs ?? slice.sourceEndMs;
      if (end - start < scene.slices.minItemDurationMs) throw new Error('A slice must last at least ' + scene.slices.minItemDurationMs + 'ms.');
      if (end > p.sourceDurationMs) throw new Error('Trim extends beyond the recording.');
      if (slice.previous && start < slice.previous.sourceEndMs) throw new Error('Trim overlaps the previous slice.');
      if (slice.next && end > slice.next.sourceStartMs) throw new Error('Trim overlaps the next slice.');
      var before = { sourceStartMs: Math.round(slice.sourceStartMs), sourceEndMs: Math.round(slice.sourceEndMs) };
      slice.update(updates);
      return { success: true, before: before,
        after: { sourceStartMs: Math.round(slice.sourceStartMs), sourceEndMs: Math.round(slice.sourceEndMs) } };
    `), globals(cmd).json);
  });

const sliceUpdate = new Command("update")
  .description("Change audio channels and cursor settings for one slice or all slices")
  .argument("<index>", "Slice index, or all")
  .option("--volume <n>", "Microphone volume (0-1)")
  .option("--system-volume <n>", "System audio volume (0-1)")
  .option("--device-volume <n>", "External device audio volume (0-1)")
  .option("--hide-cursor", "Hide the cursor")
  .option("--show-cursor", "Show the cursor")
  .option("--smooth-cursor", "Enable smooth cursor movement")
  .option("--raw-cursor", "Disable smooth cursor movement")
  .action(async (index, opts, cmd) => {
    const idx = index === "all" ? null : indexValue(index);
    if (opts.hideCursor && opts.showCursor) throw new Error("Choose --hide-cursor or --show-cursor.");
    if (opts.smoothCursor && opts.rawCursor) throw new Error("Choose --smooth-cursor or --raw-cursor.");
    const changes: Record<string, unknown> = {};
    for (const [option, key] of [["volume", "volume"], ["systemVolume", "systemAudioVolume"], ["deviceVolume", "externalDeviceAudioVolume"]]) {
      if (opts[option] !== undefined) changes[key] = numberValue(opts[option], option, 0, 1);
    }
    if (opts.hideCursor || opts.showCursor) changes.hideCursor = !!opts.hideCursor;
    if (opts.smoothCursor || opts.rawCursor) changes.disableSmoothMouseMovement = !!opts.rawCursor;
    if (!Object.keys(changes).length) throw new Error("Provide an audio or cursor option.");
    output(await evaluate(cmd, `
      var scene = ss.scene(), index = ${idx};
      if (index !== null && !scene.slices.at(index)) throw new Error('Slice index out of range: ' + index);
      var targets = index === null ? scene.slices.map(function (s) { return s; }) : [scene.slices.at(index)];
      targets.forEach(function (s) { s.update(${JSON.stringify(changes)}); });
      return { success: true, updated: targets.length };
    `), globals(cmd).json);
  });

export const sliceCommand = new Command("slice")
  .description("Manage timeline slices")
  .addCommand(sliceList)
  .addCommand(sliceSplit)
  .addCommand(sliceRemove)
  .addCommand(sliceSpeed)
  .addCommand(sliceUpdate)
  .addCommand(sliceMerge)
  .addCommand(sliceTrim);
