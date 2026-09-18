import { Command } from "commander";
import { withClient } from "../../cdp/client.js";
import { output } from "../format.js";
import { PROJECT } from "../validation.js";

// The main renderer owns the React tree, but its keyboard events do not reach
// the editor's separate window. Use the app's editor and native menu handlers.
const FIND_EXPORT_CONTROLS = `
  var root = document.getElementById('root');
  var key = root && Object.keys(root).find(function(k) { return k.startsWith('__reactContainer'); });
  var fiber = key && root[key];
  var queue = [fiber?.stateNode?.current || fiber];
  var seen = new Set();
  var editor, clipboardAction;
  while (queue.length && seen.size < 10000) {
    var node = queue.shift();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    var props = node.memoizedProps || {};
    for (var value of Object.values(props)) {
      if (value && typeof value === 'object' && value.project === p && value.exportManager) editor = value;
    }
    if (props.parent === 'Export' && props.action?.id === 'quickExportToClipboard') {
      clipboardAction = node.child?.memoizedProps;
    }
    queue.push(node.child, node.sibling);
  }
  if (!editor) throw new Error('Could not find the active project export controls in this Screen Studio build.');
`;

export const exportCommand = new Command("export")
  .description("Trigger Screen Studio export")
  .option("--clipboard", "Quick export to clipboard (Cmd+Alt+C)")
  .action(async (opts, cmd) => {
    const port = parseInt(cmd.parent?.opts().port || "9222");

    const result = await withClient(port, client => client.evaluate(`${PROJECT}
      ${FIND_EXPORT_CONTROLS}
      if (editor.exportManager.isExportInProgress) throw new Error('An export is already in progress.');
      ${opts.clipboard ? `
        if (!clipboardAction || clipboardAction.enabled === false || typeof clipboardAction.onClick !== 'function')
          throw new Error('Quick clipboard export is unavailable. Check the app export controls.');
        await clipboardAction.onClick();
        return { success: true, message: 'Triggered quick export to clipboard' };
      ` : `
        if (typeof editor.exportManager.openPicker !== 'function') throw new Error('Export dialog is unavailable in this Screen Studio build.');
        await editor.exportManager.openPicker();
        if (!editor.exportManager.isPickerOpened) throw new Error('Screen Studio did not open the export dialog. Check the app for a prompt.');
        return { success: true, message: 'Opened export dialog' };
      `}
    `));
    output(result, cmd.optsWithGlobals().json);
  });
