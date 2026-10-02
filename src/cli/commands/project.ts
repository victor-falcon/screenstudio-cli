import { Command } from "commander";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { evaluate, globals } from "../context.js";
import { output, formatMs } from "../format.js";
import { appBundle } from "./launch.js";

const projectInfo = new Command("info")
  .description("Show project information")
  .action(async (_opts, cmd) => {
    const info = await evaluate<Record<string, unknown>>(cmd, `
      var p = ss.project(), s = ss.scene(p);
      ss.flush(p);
      return {
        name: p.name, id: p.id, path: p.path,
        durationMs: Math.round(p.playbackDurationMs), sourceDurationMs: Math.round(p.sourceDurationMs),
        isDirty: p.isDirty, canUndo: p.history.canUndo, canRedo: p.history.canRedo,
        sceneCount: p.scenes.length, sliceCount: s.slices.length, zoomCount: s.zooms.length,
        maskCount: s.masks.length, layoutCount: s.layouts.length, voiceOverCount: s.voiceOvers.length,
        hasMicrophone: p.recording.hasMicrophone, hasCamera: p.recording.hasCamera,
        lastSavedAt: p.lastSavedAt,
      };
    `);
    if (globals(cmd).json) return output(info, true);
    console.log(`Name: ${info.name}`);
    console.log(`Path: ${info.path}`);
    console.log(`Duration: ${formatMs(info.durationMs as number)} (recording: ${formatMs(info.sourceDurationMs as number)})`);
    console.log(`Slices: ${info.sliceCount} | Zooms: ${info.zoomCount} | Masks: ${info.maskCount} | Layouts: ${info.layoutCount}`);
    console.log(`Dirty: ${info.isDirty} | Undo: ${info.canUndo} | Redo: ${info.canRedo}`);
    if (info.lastSavedAt) console.log(`Last Saved: ${info.lastSavedAt}`);
  });

const projectList = new Command("list")
  .description("List open projects")
  .action(async (_opts, cmd) => {
    const projects = await evaluate<Array<Record<string, unknown>>>(cmd, `
      var focused = window.$$focused && window.$$focused.project;
      return ss.projects().map(function (p) {
        return { name: p.name, path: p.path, isDirty: p.isDirty, isFocused: p === focused };
      });
    `);
    if (globals(cmd).json) return output(projects, true);
    if (!projects.length) console.log("No project open");
    for (const p of projects) console.log(`${p.isFocused ? "* " : "  "}${p.name}  ${p.path}${p.isDirty ? " (unsaved)" : ""}`);
  });

const projectOpen = new Command("open")
  .description("Open a .screenstudio project file")
  .argument("<path>", "Path to .screenstudio file")
  .option("--app <path>", "Screen Studio app bundle (default: the official app)")
  .action(async (filePath, opts, cmd) => {
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) throw new Error(`Project not found: ${absPath}`);
    // macOS delivers the app's file-open event, which opens the project editor.
    const app = appBundle(opts.app ?? cmd.optsWithGlobals().app);
    execFileSync("open", [...app.openArgs, absPath]);
    output({ success: true, path: absPath, message: "Requested project open" }, globals(cmd).json);
  });

const projectSave = new Command("save")
  .description("Save the current project")
  .action(async (_opts, cmd) => {
    output(await evaluate(cmd, `
      var p = ss.project(), ed = ss.editor(p);
      // The app's own save serializes the project and waits for the write before clearing isDirty.
      await ss.runAction('saveProject', ed);
      return { success: true, path: p.path, isDirty: p.isDirty };
    `), globals(cmd).json);
  });

const projectUndo = new Command("undo")
  .description("Undo the last change")
  .action(async (_opts, cmd) => {
    output(await evaluate(cmd, `
      var p = ss.project(), h = p.history;
      ss.flush(p);
      if (!h.canUndo) return { error: 'Nothing to undo' };
      h.undo();
      return { success: true, canUndo: h.canUndo, canRedo: h.canRedo };
    `), globals(cmd).json);
  });

const projectRedo = new Command("redo")
  .description("Redo the last undone change")
  .action(async (_opts, cmd) => {
    output(await evaluate(cmd, `
      var p = ss.project(), h = p.history;
      ss.flush(p);
      if (!h.canRedo) return { error: 'Nothing to redo' };
      h.redo();
      return { success: true, canUndo: h.canUndo, canRedo: h.canRedo };
    `), globals(cmd).json);
  });

export const projectCommand = new Command("project")
  .description("Project operations")
  .addCommand(projectInfo)
  .addCommand(projectList)
  .addCommand(projectOpen)
  .addCommand(projectSave)
  .addCommand(projectUndo)
  .addCommand(projectRedo);
