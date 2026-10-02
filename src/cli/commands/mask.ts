import { Command, Option } from "commander";
import { evaluate, globals } from "../context.js";
import { output, table } from "../format.js";
import { numberValue, timeRange } from "../validation.js";

function maskOptions(command: Command): Command {
  return command
    .option("--x <n>", "Bounds X (recording pixels)")
    .option("--y <n>", "Bounds Y (recording pixels)")
    .option("--width <n>", "Bounds width (recording pixels)")
    .option("--height <n>", "Bounds height (recording pixels)")
    .option("--blur <n>", "Blur amount")
    .addOption(new Option("--type <type>", "Mask type").choices(["sensitive-data", "highlight"]))
    .option("--opacity <n>", "Highlight mask opacity (0.1-0.9)");
}

function maskChanges(opts: Record<string, string | boolean | undefined>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (opts.blur !== undefined) changes.blur = numberValue(String(opts.blur), "Blur");
  if (opts.opacity !== undefined) changes.highlightMaskOpacity = numberValue(String(opts.opacity), "Opacity", 0.1, 0.9);
  if (opts.type !== undefined) changes.type = opts.type;
  if (opts.start !== undefined) changes.sourceStartMs = numberValue(String(opts.start), "Start time");
  if (opts.end !== undefined) changes.sourceEndMs = numberValue(String(opts.end), "End time");
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

// Preserves extra rectangles: the CLI edits the first one.
const APPLY_BOUNDS = `
  function withBounds(mask, bounds) {
    if (!Object.keys(bounds).length) return null;
    var all = JSON.parse(JSON.stringify(mask.bounds || []));
    all[0] = Object.assign({ x: 0, y: 0, width: 200, height: 100 }, all[0], bounds);
    return all;
  }
`;

const FIND_MASK = (id: string) => `
  var p = ss.project(), scene = ss.scene(p), id = ${JSON.stringify(id)};
  var mask = scene.masks.get(id);
  if (!mask) throw new Error('Mask not found: ' + id);
`;

const maskList = new Command("list")
  .description("List sensitive-data and highlight masks")
  .action(async (_opts, cmd) => {
    const masks = await evaluate<Array<Record<string, unknown>>>(cmd, `return ss.scene().masks.map(ss.itemInfo);`);
    if (globals(cmd).json) return output(masks, true);
    table(["ID", "Type", "Source Range", "Blur", "Opacity", "Disabled"], masks.map(m => [
      String(m.id), String(m.type), `${m.sourceStartMs}ms - ${m.sourceEndMs}ms`,
      String(m.blur ?? "-"), String(m.highlightMaskOpacity ?? "-"), m.isDisabled ? "yes" : "no",
    ]));
  });

const maskAdd = maskOptions(new Command("add")
  .description("Add a sensitive-data or highlight mask")
  .argument("<startMs>", "Start time in source milliseconds")
  .argument("<endMs>", "End time in source milliseconds"))
  .action(async (startMs, endMs, opts, cmd) => {
    const start = numberValue(startMs, "Start time");
    const end = numberValue(endMs, "End time");
    timeRange(start, end);
    const changes = maskChanges(opts), bounds = boundsChanges(opts);
    output(await evaluate(cmd, `${APPLY_BOUNDS}
      var p = ss.project(), scene = ss.scene(p);
      if (${end} > p.sourceDurationMs) throw new Error('Mask extends beyond the recording.');
      // Masks cannot overlap: the app fits the new mask into the free range at its start.
      var mask = scene.masks.add(Object.assign({ sourceStartMs: ${start}, sourceEndMs: ${end} }, ${JSON.stringify(changes)}));
      if (!mask) throw new Error('No free range for a mask at ' + ${start} + 'ms. Masks cannot overlap.');
      var all = withBounds(mask, ${JSON.stringify(bounds)});
      if (all) mask.update({ bounds: all });
      return Object.assign({ success: true, maskCount: scene.masks.length }, ss.itemInfo(mask));
    `), globals(cmd).json);
  });

const maskUpdate = maskOptions(new Command("update")
  .description("Update mask geometry, type, timing, or visibility")
  .argument("<id>", "Mask ID"))
  .option("--start <ms>", "Start time in source milliseconds")
  .option("--end <ms>", "End time in source milliseconds")
  .option("--disable", "Disable the mask")
  .option("--enable", "Enable the mask")
  .action(async (id, opts, cmd) => {
    const changes = maskChanges(opts), bounds = boundsChanges(opts);
    if (!Object.keys(changes).length && !Object.keys(bounds).length) throw new Error("Provide a mask property to update.");
    output(await evaluate(cmd, `${APPLY_BOUNDS} ${FIND_MASK(id)}
      var changes = ${JSON.stringify(changes)};
      var start = changes.sourceStartMs ?? mask.sourceStartMs, end = changes.sourceEndMs ?? mask.sourceEndMs;
      if (end <= start) throw new Error('End time must be greater than start time.');
      if (end > p.sourceDurationMs) throw new Error('Mask extends beyond the recording.');
      var all = withBounds(mask, ${JSON.stringify(bounds)});
      if (all) changes.bounds = all;
      mask.update(changes);
      return Object.assign({ success: true }, ss.itemInfo(mask));
    `), globals(cmd).json);
  });

const maskRemove = new Command("remove")
  .description("Remove a mask by ID")
  .argument("<id>", "Mask ID")
  .action(async (id, _opts, cmd) => {
    output(await evaluate(cmd, `${FIND_MASK(id)}
      mask.remove();
      return { success: true, maskCount: scene.masks.length };
    `), globals(cmd).json);
  });

const maskClear = new Command("clear")
  .description("Remove all masks")
  .action(async (_opts, cmd) => {
    output(await evaluate(cmd, `
      var scene = ss.scene();
      scene.masks.removeAll();
      return { success: true, maskCount: scene.masks.length };
    `), globals(cmd).json);
  });

export const maskCommand = new Command("mask")
  .description("Manage sensitive-data and highlight masks")
  .addCommand(maskList).addCommand(maskAdd).addCommand(maskUpdate).addCommand(maskRemove).addCommand(maskClear);
