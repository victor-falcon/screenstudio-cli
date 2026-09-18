import { Command, Option } from "commander";
import { withClient } from "../../cdp/client.js";
import { output, table } from "../format.js";
import { numberValue, SCENE, timeRange } from "../validation.js";

function maskOptions(command: Command): Command {
  return command
    .option("--x <n>", "Bounds X (recording coords)")
    .option("--y <n>", "Bounds Y (recording coords)")
    .option("--width <n>", "Bounds width (recording coords)")
    .option("--height <n>", "Bounds height (recording coords)")
    .option("--blur <n>", "Blur amount")
    .addOption(new Option("--type <type>", "Mask type").choices(["sensitive-data", "highlight"]))
    .option("--opacity <n>", "Highlight mask opacity (0.1-0.9)");
}

function maskChanges(opts: Record<string, string | boolean | undefined>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (opts.blur !== undefined) changes.blur = numberValue(String(opts.blur), "Blur");
  if (opts.opacity !== undefined) changes.highlightMaskOpacity = numberValue(String(opts.opacity), "Opacity", 0.1, 0.9);
  if (opts.type !== undefined) changes.type = opts.type;
  if (opts.start !== undefined) changes.startTime = numberValue(String(opts.start), "Start time");
  if (opts.end !== undefined) changes.endTime = numberValue(String(opts.end), "End time");
  if (opts.disable && opts.enable) throw new Error("Choose --disable or --enable.");
  if (opts.disable || opts.enable) changes.isDisabled = !!opts.disable;
  return changes;
}

function boundsChanges(opts: Record<string, string | undefined>): Record<string, number> {
  const bounds: Record<string, number> = {};
  for (const key of ["x", "y", "width", "height"]) {
    if (opts[key] !== undefined) {
      bounds[key] = numberValue(opts[key], key);
      if ((key === "width" || key === "height") && bounds[key] === 0) {
        throw new Error(`${key} must be greater than zero.`);
      }
    }
  }
  return bounds;
}

const CHECK_RANGE = `
  if (changes.endTime <= changes.startTime) throw new Error('End time must be greater than start time.');
  if (changes.endTime > p.recording.durationMs) throw new Error('Mask extends beyond the recording.');
`;

const maskList = new Command("list")
  .description("List sensitive-data and highlight masks")
  .action(async (_opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    const masks = await withClient(Number(opts.port), client => client.evaluate<Array<Record<string, unknown>>>(`${SCENE}
      return (scene.masks || []).map(function(m) {
        return { id: m.id, type: m.type, sourceStartTime: m.sourceStartTime,
          sourceEndTime: m.sourceEndTime, bounds: m.bounds, blur: m.blur,
          highlightMaskOpacity: m.highlightMaskOpacity, isDisabled: m.isDisabled };
      });
    `));
    if (opts.json) output(masks, true);
    else table(["ID", "Type", "Start", "End", "Blur", "Opacity", "Disabled"], masks.map(m => [
      String(m.id), String(m.type), `${m.sourceStartTime}ms`, `${m.sourceEndTime}ms`,
      String(m.blur ?? "-"), String(m.highlightMaskOpacity ?? "-"), m.isDisabled ? "yes" : "no",
    ]));
  });

const maskAdd = maskOptions(new Command("add")
  .description("Add a sensitive-data or highlight mask")
  .argument("<startMs>", "Start time in source milliseconds")
  .argument("<endMs>", "End time in source milliseconds"))
  .action(async (startMs, endMs, opts, cmd) => {
    const global = cmd.optsWithGlobals();
    const startTime = numberValue(startMs, "Start time");
    const endTime = numberValue(endMs, "End time");
    timeRange(startTime, endTime);
    const changes = { type: "sensitive-data", blur: 20, ...maskChanges(opts), startTime, endTime,
      bounds: [{ x: 0, y: 0, width: 200, height: 100, ...boundsChanges(opts) }] };
    output(await withClient(Number(global.port), client => client.evaluate(`${SCENE}
      if (typeof scene.addMask !== 'function') throw new Error('Mask creation is unavailable in this Screen Studio build.');
      var changes = ${JSON.stringify(changes)};
      ${CHECK_RANGE}
      // addMask returns the created model. masks is sorted, so its last item may be another mask.
      var mask = scene.addMask(changes);
      if (!mask) throw new Error('Failed to create mask');
      return { success: true, id: mask.id, maskCount: scene.masks.length,
        start: mask.sourceStartTime, end: mask.sourceEndTime, type: mask.type };
    `)), global.json);
  });

const maskUpdate = maskOptions(new Command("update")
  .description("Update mask geometry, type, timing, or visibility")
  .argument("<id>", "Mask ID"))
  .option("--start <ms>", "Start time in source milliseconds")
  .option("--end <ms>", "End time in source milliseconds")
  .option("--disable", "Disable the mask")
  .option("--enable", "Enable the mask")
  .action(async (id, opts, cmd) => {
    const global = cmd.optsWithGlobals();
    const changes = maskChanges(opts), bounds = boundsChanges(opts);
    if (!Object.keys(changes).length && !Object.keys(bounds).length) throw new Error("Provide a mask property to update.");
    output(await withClient(Number(global.port), client => client.evaluate(`${SCENE}
      var mask = scene.masks.find(function(m) { return m.id === ${JSON.stringify(id)}; });
      if (!mask) throw new Error('Mask not found: ' + ${JSON.stringify(id)});
      var changes = Object.assign({ startTime: mask.sourceStartTime, endTime: mask.sourceEndTime }, ${JSON.stringify(changes)});
      ${CHECK_RANGE}
      var bounds = ${JSON.stringify(bounds)};
      if (Object.keys(bounds).length) {
        changes.bounds = JSON.parse(JSON.stringify(mask.bounds || []));
        changes.bounds[0] = Object.assign({ x: 0, y: 0, width: 200, height: 100 }, changes.bounds[0], bounds);
      }
      scene.updateMask(mask.id, changes);
      return { success: true, id: mask.id };
    `)), global.json);
  });

const maskRemove = new Command("remove")
  .description("Remove a mask by ID")
  .argument("<id>", "Mask ID")
  .action(async (id, _opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    output(await withClient(Number(opts.port), client => client.evaluate(`${SCENE}
      var id = ${JSON.stringify(id)};
      if (!scene.masks.some(function(m) { return m.id === id; })) throw new Error('Mask not found: ' + id);
      scene.removeMask(id);
      return { success: true, maskCount: scene.masks.length };
    `)), opts.json);
  });

const maskClear = new Command("clear")
  .description("Remove all masks")
  .action(async (_opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    output(await withClient(Number(opts.port), client => client.evaluate(`${SCENE}
      scene.update({ masks: [] });
      return { success: true, maskCount: 0 };
    `)), opts.json);
  });

export const maskCommand = new Command("mask")
  .description("Manage sensitive-data and highlight masks")
  .addCommand(maskList).addCommand(maskAdd).addCommand(maskUpdate).addCommand(maskRemove).addCommand(maskClear);
