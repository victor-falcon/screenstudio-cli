import { Command } from "commander";
import { evaluate, globals } from "../context.js";
import { output, table } from "../format.js";

interface ActionInfo {
  id: string;
  target: string | null;
  applies: boolean;
  shortcut: string | null;
}

// Screen Studio's command menu actions. Editor actions run against the project's editor;
// actions for zooms, masks, slices or layouts need --zoom, --mask, --slice or --layout.
const ACTION_TARGET = (opts: Record<string, string | undefined>) => `
  var p = ss.project(), ed = ss.editor(p), scene = p.scene, target = ed;
  var pick = function (collection, key, label) {
    var item = /^\\d+$/.test(key) ? collection.at(Number(key)) : collection.get(key);
    if (!item) throw new Error(label + ' not found: ' + key);
    return item;
  };
  ${opts.zoom ? `target = pick(scene.zooms, ${JSON.stringify(opts.zoom)}, 'Zoom');` : ""}
  ${opts.mask ? `target = pick(scene.masks, ${JSON.stringify(opts.mask)}, 'Mask');` : ""}
  ${opts.slice ? `target = pick(scene.slices, ${JSON.stringify(opts.slice)}, 'Slice');` : ""}
  ${opts.layout ? `target = pick(scene.layouts, ${JSON.stringify(opts.layout)}, 'Layout');` : ""}
`;

const actionList = new Command("list")
  .description("List Screen Studio actions and whether they apply to the project editor now")
  .option("--all", "Include actions that do not apply right now")
  .option("--search <text>", "Filter by id")
  .action(async (opts, cmd) => {
    const actions = await evaluate<ActionInfo[]>(cmd, `
      var editor = null;
      try { editor = ss.editor(); } catch (e) { /* Global actions still apply. */ }
      var context = ss.actionContext(editor);
      return ss.actionManager().actions.map(function (a) {
        var applies = false;
        try { applies = !!a.canApply(context); } catch (e) { /* Needs another target type. */ }
        var shortcut = a.defaultShortcut;
        return { id: a.id, target: a.targetTypeDescription?.name ?? null, applies: applies,
          shortcut: Array.isArray(shortcut) ? shortcut.join('+') : shortcut ?? null };
      });
    `);
    const search = opts.search?.toLowerCase();
    const shown = actions.filter(a => (opts.all || a.applies) && (!search || a.id.toLowerCase().includes(search)));
    if (globals(cmd).json) return output(shown, true);
    table(["Action", "Target", "Applies", "Shortcut"], shown.map(a => [a.id, a.target ?? "-", a.applies ? "yes" : "no", a.shortcut ?? ""]));
  });

const actionRun = new Command("run")
  .description("Run a Screen Studio action by id (see action list)")
  .argument("<id>", "Action id, e.g. saveProject, toggleZoomLoupeMode, resetTrimsAndCutsForAllSlices")
  .option("--zoom <id>", "Run against a zoom (id or index)")
  .option("--mask <id>", "Run against a mask (id or index)")
  .option("--slice <id>", "Run against a slice (id or index)")
  .option("--layout <id>", "Run against a layout (id or index)")
  .option("--input <json>", "Input value for actions that take one")
  .action(async (id, opts, cmd) => {
    const targets = ["zoom", "mask", "slice", "layout"].filter(key => opts[key] !== undefined);
    if (targets.length > 1) throw new Error("Choose one target option.");
    let input: unknown;
    if (opts.input !== undefined) {
      try { input = JSON.parse(opts.input); } catch { input = opts.input; }
    }
    output(await evaluate(cmd, `${ACTION_TARGET(opts)}
      await ss.runAction(${JSON.stringify(id)}, target, ${input === undefined ? "undefined" : JSON.stringify(input)});
      return { success: true, action: ${JSON.stringify(id)} };
    `, 120_000), globals(cmd).json);
  });

export const actionCommand = new Command("action")
  .description("List and run Screen Studio's own command menu actions")
  .addCommand(actionList)
  .addCommand(actionRun);
