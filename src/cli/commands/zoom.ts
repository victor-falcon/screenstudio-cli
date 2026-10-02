import { Command, Option } from "commander";
import { evaluate, globals } from "../context.js";
import { output } from "../format.js";
import { numberValue, timeRange } from "../validation.js";
import { printZoomTable } from "./state.js";

// Screen Studio 4 renamed 3.x's "auto" zoom to "follow-mouse"; "auto" stays an alias.
export const ZOOM_TYPES = ["manual", "follow-mouse", "follow-click-groups"] as const;

function zoomOptions(command: Command): Command {
  return command
    .option("--level <n>", "Zoom level (1 or more)")
    .option("--x <n>", "Manual target point X (0-1)")
    .option("--y <n>", "Manual target point Y (0-1)")
    .addOption(new Option("--type <type>", "manual (fixed point), follow-mouse (auto), or follow-click-groups").choices([...ZOOM_TYPES, "auto"]))
    .option("--loupe", "Glass Loupe: magnify a lens over the screen instead of zooming the whole frame")
    .option("--screen", "Zoom the whole screen (default)")
    .option("--radius <n>", "Loupe radius (0-1 of the frame)")
    .option("--bevel <n>", "Loupe bevel ratio (0-1)")
    .option("--aberration <n>", "Loupe chromatic aberration (0-1)")
    .option("--no-glass", "Loupe without glass optics")
    .option("--instant", "Use instant zoom animation")
    .option("--animated", "Use smooth zoom animation");
}

function zoomChanges(opts: Record<string, string | boolean | undefined>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (opts.level !== undefined) changes.zoom = numberValue(String(opts.level), "Zoom level", 1);
  if (opts.type !== undefined) changes.type = opts.type === "auto" ? "follow-mouse" : opts.type;
  if (opts.loupe && opts.screen) throw new Error("Choose --loupe or --screen.");
  if (opts.loupe || opts.screen) changes.presentation = opts.loupe ? "loupe" : "screen";
  if (opts.instant && opts.animated) throw new Error("Choose --instant or --animated.");
  if (opts.instant || opts.animated) changes.hasInstantAnimation = !!opts.instant;
  const loupe: Record<string, unknown> = {};
  if (opts.radius !== undefined) loupe.radius01 = numberValue(String(opts.radius), "Loupe radius", 0, 1);
  if (opts.bevel !== undefined) loupe.bevelRatio = numberValue(String(opts.bevel), "Loupe bevel", 0, 1);
  if (opts.aberration !== undefined) loupe.chromaticAberration = numberValue(String(opts.aberration), "Chromatic aberration", 0, 1);
  if (opts.glass === false) loupe.hasGlassOptics = false;
  if (Object.keys(loupe).length) changes.loupeOptions = loupe;
  const point: Record<string, number> = {};
  if (opts.x !== undefined) point.x = numberValue(String(opts.x), "X", 0, 1);
  if (opts.y !== undefined) point.y = numberValue(String(opts.y), "Y", 0, 1);
  if (Object.keys(point).length) changes.manualTargetPoint = point;
  return changes;
}

// Partial loupe options and target points are merged into the zoom's current values.
const MERGE_CHANGES = `
  function mergeZoomChanges(current, changes) {
    var result = Object.assign({}, changes);
    if (changes.loupeOptions) result.loupeOptions = Object.assign({}, current.loupeOptions, changes.loupeOptions);
    if (changes.manualTargetPoint) result.manualTargetPoint = Object.assign({ x: 0.5, y: 0.5 }, current.manualTargetPoint, changes.manualTargetPoint);
    return result;
  }
`;

const FIND_ZOOM = (id: string) => `
  var p = ss.project(), scene = ss.scene(p), id = ${JSON.stringify(id)};
  var zoom = scene.zooms.get(id);
  if (!zoom) throw new Error('Zoom not found: ' + id);
`;

const zoomList = new Command("list")
  .description("List all zooms")
  .action(async (_opts, cmd) => {
    const zooms = await evaluate<Parameters<typeof printZoomTable>[0]>(cmd, `return ss.scene().zooms.map(ss.itemInfo);`);
    if (globals(cmd).json) output(zooms, true);
    else printZoomTable(zooms);
  });

const zoomAdd = zoomOptions(new Command("add")
  .description("Add a zoom at a source time")
  .argument("<timeMs>", "Source start time in milliseconds")
  .option("--end <ms>", "Source end time in ms (default: start + 3000)"))
  .action(async (timeMs, opts, cmd) => {
    const start = numberValue(timeMs, "Start time");
    const end = opts.end !== undefined ? numberValue(opts.end, "End time") : start + 3000;
    timeRange(start, end);
    const changes = { zoom: 2, type: "manual", ...zoomChanges(opts) };
    output(await evaluate(cmd, `${MERGE_CHANGES}
      var p = ss.project(), scene = ss.scene(p);
      if (${end} > p.sourceDurationMs) throw new Error('Zoom extends beyond the recording.');
      var changes = ${JSON.stringify(changes)}, nested = { loupeOptions: changes.loupeOptions, manualTargetPoint: changes.manualTargetPoint };
      delete changes.loupeOptions; delete changes.manualTargetPoint;
      // Zooms cannot overlap: the app fits the new zoom into the free range at its start.
      var zoom = scene.zooms.add(Object.assign({ sourceStartMs: ${start}, sourceEndMs: ${end} }, changes));
      if (!zoom) throw new Error('No free range for a zoom at ' + ${start} + 'ms. Zooms cannot overlap.');
      if (nested.loupeOptions || nested.manualTargetPoint) zoom.update(mergeZoomChanges(zoom.serialize(), nested));
      return Object.assign({ success: true, zoomCount: scene.zooms.length }, ss.itemInfo(zoom));
    `), globals(cmd).json);
  });

const zoomUpdate = zoomOptions(new Command("update")
  .description("Update a zoom")
  .argument("<id>", "Zoom ID")
  .option("--start <ms>", "Source start time in ms")
  .option("--end <ms>", "Source end time in ms")
  .option("--disable", "Disable the zoom")
  .option("--enable", "Enable the zoom"))
  .action(async (id, opts, cmd) => {
    const changes = zoomChanges(opts);
    if (opts.start !== undefined) changes.sourceStartMs = numberValue(opts.start, "Start time");
    if (opts.end !== undefined) changes.sourceEndMs = numberValue(opts.end, "End time");
    if (opts.disable && opts.enable) throw new Error("Choose --disable or --enable.");
    if (opts.disable || opts.enable) changes.isDisabled = !!opts.disable;
    if (!Object.keys(changes).length) throw new Error("Provide a zoom property to update.");
    output(await evaluate(cmd, `${MERGE_CHANGES} ${FIND_ZOOM(id)}
      var changes = mergeZoomChanges(zoom.serialize(), ${JSON.stringify(changes)});
      var start = changes.sourceStartMs ?? zoom.sourceStartMs, end = changes.sourceEndMs ?? zoom.sourceEndMs;
      if (end <= start) throw new Error('End time must be greater than start time.');
      if (zoom.previous && start < zoom.previous.sourceEndMs) throw new Error('Zoom overlaps the previous zoom.');
      if (zoom.next && end > zoom.next.sourceStartMs) throw new Error('Zoom overlaps the next zoom.');
      zoom.update(changes);
      return Object.assign({ success: true }, ss.itemInfo(zoom));
    `), globals(cmd).json);
  });

const zoomRemove = new Command("remove")
  .description("Remove a zoom by ID")
  .argument("<id>", "Zoom ID")
  .action(async (id, _opts, cmd) => {
    output(await evaluate(cmd, `${FIND_ZOOM(id)}
      zoom.remove();
      return { success: true, zoomCount: scene.zooms.length };
    `), globals(cmd).json);
  });

const zoomSplit = new Command("split")
  .description("Split a zoom at a source time")
  .argument("<id>", "Zoom ID")
  .argument("<timeMs>", "Source time in milliseconds to split at")
  .action(async (id, timeMs, _opts, cmd) => {
    const time = numberValue(timeMs, "Split time");
    output(await evaluate(cmd, `${FIND_ZOOM(id)}
      var time = ${time};
      if (time <= zoom.sourceStartMs || time >= zoom.sourceEndMs) {
        throw new Error('Split time must be within the zoom (' + Math.round(zoom.sourceStartMs) + 'ms - ' + Math.round(zoom.sourceEndMs) + 'ms)');
      }
      if (!scene.zooms.canSplitAt(time)) throw new Error('Both parts must last at least ' + scene.zooms.minItemDurationMs + 'ms.');
      scene.zooms.splitAt(time);
      return { success: true, originalId: id, newId: scene.zooms.findNextAt(time)?.id ?? null, splitAt: time };
    `), globals(cmd).json);
  });

const zoomClear = new Command("clear")
  .description("Remove all zooms")
  .action(async (_opts, cmd) => {
    output(await evaluate(cmd, `
      var scene = ss.scene();
      scene.zooms.removeAll();
      return { success: true, zoomCount: scene.zooms.length };
    `), globals(cmd).json);
  });

const zoomSet = new Command("set")
  .description("Replace all zooms at once (JSON array of zoom data, as printed by zoom list --json)")
  .argument("<json>", "JSON array of zoom objects")
  .action(async (jsonStr, _opts, cmd) => {
    let zoomData: unknown;
    try { zoomData = JSON.parse(jsonStr); } catch { throw new Error("Invalid JSON"); }
    if (!Array.isArray(zoomData)) throw new Error("Zoom data must be an array.");
    for (const item of zoomData) {
      if (!item || typeof item !== "object") throw new Error("Each zoom must be an object.");
      const zoom = item as Record<string, unknown>;
      for (const key of ["sourceStartMs", "sourceEndMs", "zoom"]) {
        if (typeof zoom[key] !== "number") throw new Error(`Zoom ${key} must be a number.`);
        numberValue(String(zoom[key]), key, key === "zoom" ? 1 : 0);
      }
      timeRange(zoom.sourceStartMs as number, zoom.sourceEndMs as number);
      if (zoom.type === "auto") zoom.type = "follow-mouse";
      if (zoom.type !== undefined && !(ZOOM_TYPES as readonly string[]).includes(String(zoom.type))) throw new Error(`Zoom type must be one of: ${ZOOM_TYPES.join(", ")}.`);
      if (zoom.presentation !== undefined && !["screen", "loupe"].includes(String(zoom.presentation))) throw new Error("Zoom presentation must be screen or loupe.");
    }
    output(await evaluate(cmd, `
      var scene = ss.scene(), data = ${JSON.stringify(zoomData)};
      var keys = ['sourceStartMs', 'sourceEndMs', 'zoom', 'type', 'presentation', 'isDisabled', 'hasInstantAnimation'];
      scene.zooms.removeAll();
      var skipped = 0;
      data.slice().sort(function (a, b) { return a.sourceStartMs - b.sourceStartMs; }).forEach(function (z) {
        var input = {};
        keys.forEach(function (k) { if (z[k] !== undefined) input[k] = z[k]; });
        var zoom = scene.zooms.add(input);
        if (!zoom) { skipped++; return; }
        var current = zoom.serialize();
        if (z.loupeOptions || z.manualTargetPoint) zoom.update({
          loupeOptions: Object.assign({}, current.loupeOptions, z.loupeOptions),
          manualTargetPoint: Object.assign({}, current.manualTargetPoint, z.manualTargetPoint),
        });
      });
      return { success: true, zoomCount: scene.zooms.length, skippedOverlapping: skipped };
    `), globals(cmd).json);
  });

export const zoomCommand = new Command("zoom")
  .description("Manage zooms, including Glass Loupe zooms")
  .addCommand(zoomList)
  .addCommand(zoomAdd)
  .addCommand(zoomUpdate)
  .addCommand(zoomRemove)
  .addCommand(zoomSplit)
  .addCommand(zoomClear)
  .addCommand(zoomSet);
