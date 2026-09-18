import { PROJECT_LOOKUP } from "../validation.js";
import { Command } from "commander";
import { withClient } from "../../cdp/client.js";
import { output, formatMs } from "../format.js";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const projectInfo = new Command("info")
  .description("Show project information")
  .action(async (_opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    const info = await withClient(port, async (client) => {
      return client.evaluate(`
        ${PROJECT_LOOKUP}
        if (!p) return { error: 'No project open' };
        return {
          name: p.name, id: p.id, path: p.path,
          durationMs: Math.round(p.playbackDurationMs),
          isDirty: p.isDirty, canUndo: p.history?.canUndo, canRedo: p.history?.canRedo,
          sceneCount: p.scenes.length,
          sliceCount: p.scenes[0] ? p.scenes[0].slices.length : 0,
          zoomCount: p.scenes[0] ? p.scenes[0].zoomRanges.length : 0,
          hasAudio: p.hasAudio,
          lastSavedAt: p.lastSavedAt,
        };
      `);
    });

    if (json) {
      output(info, true);
    } else {
      const i = info as Record<string, unknown>;
      console.log(`Name: ${i.name}`);
      console.log(`Path: ${i.path}`);
      console.log(`Duration: ${formatMs(i.durationMs as number)}`);
      console.log(`Slices: ${i.sliceCount} | Zoom Ranges: ${i.zoomCount}`);
      console.log(`Dirty: ${i.isDirty} | Undo: ${i.canUndo} | Redo: ${i.canRedo}`);
      if (i.lastSavedAt) console.log(`Last Saved: ${i.lastSavedAt}`);
    }
  });

const projectOpen = new Command("open")
  .description("Open a .screenstudio project file")
  .argument("<path>", "Path to .screenstudio file")
  .action(async (filePath, _opts, cmd) => {
    const json = cmd.parent?.parent?.opts().json || false;
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) throw new Error(`Project not found: ${absPath}`);
    // readProject only reads data; macOS open delivers the app's file-open event.
    execFileSync("open", ["-a", "Screen Studio", absPath]);
    output({ success: true, path: absPath, message: "Requested project open" }, json);
  });

const projectSave = new Command("save")
  .description("Save the current project")
  .action(async (_opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    const result = await withClient(port, async (client) => {
      return client.evaluate(`
        ${PROJECT_LOOKUP}
        if (!p) return { error: 'No project open' };
        if (!p.rawData) throw new Error('Project saving is unavailable in this Screen Studio build.');
        await bridge.client.mutation('project.updateProject', {
          projectPath: p.path,
          data: p.rawData,
        });
        if (typeof p.markAsJustSaved === 'function') p.markAsJustSaved();
        return { success: true, path: p.path };
      `);
    });

    output(result, json);
  });

const projectUndo = new Command("undo")
  .description("Undo the last change")
  .action(async (_opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    const result = await withClient(port, async (client) => {
      return client.evaluate(`
        ${PROJECT_LOOKUP}
        if (!p) return { error: 'No project open' };
        p.history.historyBuffer?.flush();
        if (!p.history.canUndo) return { error: 'Nothing to undo' };
        p.history.undo();
        return { success: true, canUndo: p.history.canUndo, canRedo: p.history.canRedo };
      `);
    });

    output(result, json);
  });

const projectRedo = new Command("redo")
  .description("Redo the last undone change")
  .action(async (_opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    const result = await withClient(port, async (client) => {
      return client.evaluate(`
        ${PROJECT_LOOKUP}
        if (!p) return { error: 'No project open' };
        p.history.historyBuffer?.flush();
        if (!p.history.canRedo) return { error: 'Nothing to redo' };
        p.history.redo();
        return { success: true, canUndo: p.history.canUndo, canRedo: p.history.canRedo };
      `);
    });

    output(result, json);
  });

export const projectCommand = new Command("project")
  .description("Project operations")
  .addCommand(projectInfo)
  .addCommand(projectOpen)
  .addCommand(projectSave)
  .addCommand(projectUndo)
  .addCommand(projectRedo);
