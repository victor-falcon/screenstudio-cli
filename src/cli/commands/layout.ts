import { Command, Option } from "commander";
import { evaluate, globals } from "../context.js";
import { output, table } from "../format.js";
import { numberValue, timeRange } from "../validation.js";

export const LAYOUT_TYPES = ["camera-overlay", "split-screen", "fullscreen-camera", "screen-only", "cutout-camera"] as const;

const FIND_LAYOUT = (id: string) => `
  var p = ss.project(), scene = ss.scene(p), id = ${JSON.stringify(id)};
  var layout = scene.layouts.get(id);
  if (!layout) throw new Error('Layout not found: ' + id);
`;

const layoutList = new Command("list")
  .description("List camera layout ranges")
  .action(async (_opts, cmd) => {
    const layouts = await evaluate<Array<Record<string, unknown>>>(cmd, `return ss.scene().layouts.map(ss.itemInfo);`);
    if (globals(cmd).json) return output(layouts, true);
    table(["ID", "Type", "Source Range", "Disabled"], layouts.map(l => [
      String(l.id), String(l.type), `${l.sourceStartMs}ms - ${l.sourceEndMs}ms`, l.isDisabled ? "yes" : "no",
    ]));
  });

const layoutAdd = new Command("add")
  .description("Switch the camera layout for a source time range")
  .argument("<startMs>", "Start time in source milliseconds")
  .argument("<endMs>", "End time in source milliseconds")
  .addOption(new Option("--type <type>", "Layout type").choices([...LAYOUT_TYPES]).default("fullscreen-camera"))
  .action(async (startMs, endMs, opts, cmd) => {
    const start = numberValue(startMs, "Start time");
    const end = numberValue(endMs, "End time");
    timeRange(start, end);
    output(await evaluate(cmd, `
      var p = ss.project(), scene = ss.scene(p);
      if (!p.recording.hasCamera) throw new Error('This recording has no camera.');
      if (${end} > p.sourceDurationMs) throw new Error('Layout extends beyond the recording.');
      var layout = scene.layouts.add({ sourceStartMs: ${start}, sourceEndMs: ${end} });
      if (!layout) throw new Error('No free range for a layout at ' + ${start} + 'ms. Layouts cannot overlap.');
      layout.changeType(${JSON.stringify(opts.type)});
      return Object.assign({ success: true, layoutCount: scene.layouts.length }, ss.itemInfo(layout));
    `), globals(cmd).json);
  });

const layoutUpdate = new Command("update")
  .description("Change a layout's type, timing, or visibility")
  .argument("<id>", "Layout ID")
  .addOption(new Option("--type <type>", "Layout type").choices([...LAYOUT_TYPES]))
  .option("--start <ms>", "Start time in source milliseconds")
  .option("--end <ms>", "End time in source milliseconds")
  .option("--disable", "Disable the layout")
  .option("--enable", "Enable the layout")
  .action(async (id, opts, cmd) => {
    const changes: Record<string, unknown> = {};
    if (opts.start !== undefined) changes.sourceStartMs = numberValue(opts.start, "Start time");
    if (opts.end !== undefined) changes.sourceEndMs = numberValue(opts.end, "End time");
    if (opts.disable && opts.enable) throw new Error("Choose --disable or --enable.");
    if (opts.disable || opts.enable) changes.isDisabled = !!opts.disable;
    if (!Object.keys(changes).length && !opts.type) throw new Error("Provide a layout property to update.");
    output(await evaluate(cmd, `${FIND_LAYOUT(id)}
      var changes = ${JSON.stringify(changes)};
      var start = changes.sourceStartMs ?? layout.sourceStartMs, end = changes.sourceEndMs ?? layout.sourceEndMs;
      if (end <= start) throw new Error('End time must be greater than start time.');
      if (layout.previous && start < layout.previous.sourceEndMs) throw new Error('Layout overlaps the previous layout.');
      if (layout.next && end > layout.next.sourceStartMs) throw new Error('Layout overlaps the next layout.');
      if (Object.keys(changes).length) layout.update(changes);
      ${opts.type ? `layout.changeType(${JSON.stringify(opts.type)});` : ""}
      return Object.assign({ success: true }, ss.itemInfo(layout));
    `), globals(cmd).json);
  });

const layoutRemove = new Command("remove")
  .description("Remove a layout by ID (the default layout applies again)")
  .argument("<id>", "Layout ID")
  .action(async (id, _opts, cmd) => {
    output(await evaluate(cmd, `${FIND_LAYOUT(id)}
      layout.remove();
      return { success: true, layoutCount: scene.layouts.length };
    `), globals(cmd).json);
  });

const layoutClear = new Command("clear")
  .description("Remove all layout ranges")
  .action(async (_opts, cmd) => {
    output(await evaluate(cmd, `
      var scene = ss.scene();
      scene.layouts.removeAll();
      return { success: true, layoutCount: scene.layouts.length };
    `), globals(cmd).json);
  });

export const layoutCommand = new Command("layout")
  .description("Manage camera layout ranges (overlay, split screen, fullscreen camera...)")
  .addCommand(layoutList).addCommand(layoutAdd).addCommand(layoutUpdate).addCommand(layoutRemove).addCommand(layoutClear);
