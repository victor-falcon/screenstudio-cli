import { Command } from "commander";
import { withClient } from "../../cdp/client.js";
import { output, table } from "../format.js";
import { indexValue, numberValue, timeRange, SCENE, PROJECT_LOOKUP } from "../validation.js";

const sliceList = new Command("list")
  .description("List all slices on the timeline")
  .action(async (_opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    const slices = await withClient(port, async (client) => {
      return client.evaluate(`
        ${PROJECT_LOOKUP}
        if (!p) return { error: 'No project open' };
        var scene = p.scenes[0];
        if (!scene) return { error: 'No scene' };
        return scene.slices.map(function(s) {
          return {
            id: s.id, index: s.index,
            sourceStartMs: Math.round(s.sourceStartMs), sourceEndMs: Math.round(s.sourceEndMs),
            playbackStartMs: Math.round(s.playbackStartMs), playbackEndMs: Math.round(s.playbackEndMs),
            speed: s.speed, volume: s.volume, hideCursor: s.hideCursor,
            systemAudioVolume: s.systemAudioVolume,
            externalDeviceAudioVolume: s.externalDeviceAudioVolume,
            disableSmoothMouseMovement: s.disableSmoothMouseMovement,
          };
        });
      `);
    });

    if (json) {
      output(slices, true);
    } else {
      const rows = (slices as Array<Record<string, unknown>>).map((s) => [
        String(s.index),
        `${s.sourceStartMs}ms - ${s.sourceEndMs}ms`,
        `${s.playbackStartMs}ms - ${s.playbackEndMs}ms`,
        `${s.speed}x`,
        String(s.volume),
      ]);
      table(["Slice", "Source Range", "Playback Range", "Speed", "Volume"], rows);
    }
  });

const sliceSplit = new Command("split")
  .description("Split a slice at a source time (in ms)")
  .argument("<timeMs>", "Source time in milliseconds")
  .action(async (timeMs, _opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;
    const time = numberValue(timeMs, "Split time");

    const result = await withClient(port, async (client) => {
      return client.evaluate(`
        ${SCENE}
        var slice = scene.findSliceAtTime(${time});
        if (!slice) return { error: 'No slice found at ${time}ms' };
        if (!slice.canSplitAt(${time})) return { error: 'Cannot split at ${time}ms' };
        slice.splitAt(${time});
        return { success: true, sliceCount: scene.slices.length };
      `);
    });

    output(result, json);
  });

const sliceRemove = new Command("remove")
  .description("Remove a slice by index, or a time range with --from/--to")
  .argument("[index]", "Slice index to remove")
  .option("--from <ms>", "Start of time range to remove (source ms)")
  .option("--to <ms>", "End of time range to remove (source ms)")
  .action(async (index, opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    const hasRange = opts.from !== undefined || opts.to !== undefined;
    if (hasRange && (opts.from === undefined || opts.to === undefined || index !== undefined)) {
      throw new Error("Provide either a slice index or both --from and --to.");
    }
    if (hasRange) {
      const fromMs = numberValue(opts.from, "Start time");
      const toMs = numberValue(opts.to, "End time");
      timeRange(fromMs, toMs);

      const result = await withClient(port, async (client) => {
        return client.evaluate(`
          ${SCENE}
          var fromMs = ${fromMs};
          var toMs = ${toMs};
          if (toMs > p.recording.durationMs) throw new Error('Removal range extends beyond the recording.');

          // Split at the start boundary
          var sliceAtFrom = scene.findSliceAtTime(fromMs);
          if (sliceAtFrom && sliceAtFrom.canSplitAt(fromMs)) {
            sliceAtFrom.splitAt(fromMs);
          }

          // Split at the end boundary
          var sliceAtTo = scene.findSliceAtTime(toMs);
          if (sliceAtTo && sliceAtTo.canSplitAt(toMs)) {
            sliceAtTo.splitAt(toMs);
          }

          // Remove all slices fully within the range (iterate backwards)
          var toRemove = [];
          for (var i = 0; i < scene.slices.length; i++) {
            var s = scene.slices[i];
            if (s.sourceStartMs >= fromMs && s.sourceEndMs <= toMs) {
              toRemove.push(i);
            }
          }
          for (var j = toRemove.length - 1; j >= 0; j--) {
            scene.slices[toRemove[j]].remove();
          }

          return {
            success: true,
            removed: toRemove.length,
            remainingSlices: scene.slices.length,
            newDurationMs: Math.round(p.playbackDurationMs),
          };
        `);
      });

      output(result, json);
    } else if (index !== undefined) {
      const idx = indexValue(index);

      const result = await withClient(port, async (client) => {
        return client.evaluate(`
          ${SCENE}
          if (${idx} < 0 || ${idx} >= scene.slices.length) {
            return { error: 'Slice index ${idx} out of range (0-' + (scene.slices.length - 1) + ')' };
          }
          scene.slices[${idx}].remove();
          return { success: true, remainingSlices: scene.slices.length };
        `);
      });

      output(result, json);
    } else {
      throw new Error("Provide a slice index or --from/--to range.");
    }
  });

const sliceSpeed = new Command("speed")
  .description("Set playback speed of one slice or all slices")
  .argument("<index>", "Slice index, or all")
  .argument("<speed>", "Speed multiplier (e.g. 2.0)")
  .action(async (index, speed, _opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;
    const idx = index === "all" ? null : indexValue(index);
    const spd = numberValue(speed, "Speed");
    if (spd <= 0 || !Number.isFinite(1 / spd)) throw new Error("Speed must be greater than zero with a finite time scale.");

    const result = await withClient(port, async (client) => {
      return client.evaluate(`
        ${SCENE}
        var index = ${idx};
        if (index !== null && !scene.slices[index]) throw new Error('Slice index out of range: ' + index);
        if (!scene.slices.length) throw new Error('No slices');
        var slices = scene.slices.map(function(slice, i) {
          var data = JSON.parse(JSON.stringify(slice.data));
          if (index === null || index === i) data.timeScale = 1 / ${spd};
          return data;
        });
        scene.update({ slices: slices });
        return { success: true, index: index === null ? 'all' : index, speed: ${spd},
          updated: index === null ? slices.length : 1 };
      `);
    });

    output(result, json);
  });

const sliceMerge = new Command("merge")
  .description("Merge a slice with the next one")
  .argument("<index>", "Slice index to merge with next")
  .action(async (index, _opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;
    const idx = indexValue(index);

    const result = await withClient(port, async (client) => {
      return client.evaluate(`
        ${SCENE}
        if (${idx} < 0 || ${idx} >= scene.slices.length) {
          return { error: 'Slice index ${idx} out of range' };
        }
        if (!scene.slices[${idx + 1}]) throw new Error('No next slice to merge.');
        scene.slices[${idx}].mergeWithNext();
        return { success: true, remainingSlices: scene.slices.length };
      `);
    });

    output(result, json);
  });

const sliceTrim = new Command("trim")
  .description("Adjust the start or end boundary of a slice")
  .argument("<index>", "Slice index")
  .option("--start <ms>", "New source start time in ms")
  .option("--end <ms>", "New source end time in ms")
  .action(async (index, opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;
    const idx = indexValue(index);

    if (opts.start === undefined && opts.end === undefined) {
      throw new Error("Provide --start and/or --end.");
    }

    const updates: Record<string, number> = {};
    if (opts.start !== undefined) updates.sourceStartMs = numberValue(opts.start, "Start time");
    if (opts.end !== undefined) updates.sourceEndMs = numberValue(opts.end, "End time");

    const result = await withClient(port, async (client) => {
      return client.evaluate(`
        ${SCENE}
        if (${idx} < 0 || ${idx} >= scene.slices.length) {
          return { error: 'Slice index ${idx} out of range (0-' + (scene.slices.length - 1) + ')' };
        }
        var s = scene.slices[${idx}];
        var updates = ${JSON.stringify(updates)};
        var start = updates.sourceStartMs ?? s.sourceStartMs;
        var end = updates.sourceEndMs ?? s.sourceEndMs;
        if (end <= start) throw new Error('End time must be greater than start time.');
        if (end > p.recording.durationMs) throw new Error('Trim extends beyond the recording.');
        var before = { sourceStartMs: Math.round(s.sourceStartMs), sourceEndMs: Math.round(s.sourceEndMs) };
        s.update(updates);
        var after = { sourceStartMs: Math.round(s.sourceStartMs), sourceEndMs: Math.round(s.sourceEndMs) };
        return { success: true, before: before, after: after };
      `);
    });

    output(result, json);
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
    const global = cmd.optsWithGlobals();
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
    output(await withClient(Number(global.port), client => client.evaluate(`${SCENE}
      var index = ${idx};
      if (index !== null && !scene.slices[index]) throw new Error('Slice index out of range: ' + index);
      if (!scene.slices.length) throw new Error('No slices');
      var slices = scene.slices.map(function(slice, i) {
        var data = JSON.parse(JSON.stringify(slice.data));
        if (index === null || index === i) Object.assign(data, ${JSON.stringify(changes)});
        return data;
      });
      scene.update({ slices: slices });
      return { success: true, updated: index === null ? slices.length : 1 };
    `)), global.json);
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
