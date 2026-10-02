import { Command } from "commander";
import { evaluate, globals } from "../context.js";
import { output, formatMs, table } from "../format.js";

export const STATE_EXPRESSION = `
  var p = ss.project();
  ss.flush(p);
  var scenes = p.scenes.map(function (scene) {
    return {
      id: scene.id, name: scene.name, type: scene.type,
      slices: scene.slices.map(ss.sliceInfo),
      zooms: scene.zooms.map(ss.itemInfo),
      layouts: scene.layouts.map(ss.itemInfo),
      masks: scene.masks.map(ss.itemInfo),
      voiceOvers: scene.voiceOvers.map(ss.itemInfo),
    };
  });
  var rec = p.recording;
  var recording = rec ? {
    durationMs: Math.round(rec.durationMs), path: p.path + '/recording', mode: rec.mode,
    hasCamera: rec.hasCamera, hasAudio: rec.hasAudio, hasCursor: rec.hasCursor,
    hasKeystrokes: rec.hasKeystrokes, hasMicrophone: rec.hasMicrophone,
    hasSystemAudio: rec.hasSystemAudio, hasExternalDeviceAudio: rec.hasExternalDeviceAudio,
    keystrokeCount: rec.keystrokes?.length || 0, mouseEventCount: rec.mouseEvents?.length || 0,
    sessions: (rec.sessions || []).map(function (s) {
      return { recordingStartMs: s.recordingStartMs, durationMs: s.durationMs,
        videoPath: s.recordingVideoPath, webcamPath: s.webcamVideoPath };
    }),
  } : null;
  return {
    project: { name: p.name, id: p.id, path: p.path, durationMs: Math.round(p.playbackDurationMs),
      isDirty: p.isDirty, canUndo: p.history.canUndo, canRedo: p.history.canRedo },
    config: p.projectConfig.serialize(), scenes: scenes, recording: recording,
  };
`;

interface SliceData {
  index: number;
  sourceStartMs: number;
  sourceEndMs: number;
  playbackStartMs: number;
  playbackEndMs: number;
  speed: number;
  volume: number;
}

interface ZoomData {
  id: string;
  type: string;
  presentation: string;
  zoom: number;
  sourceStartMs: number;
  sourceEndMs: number;
  isDisabled: boolean;
}

interface SceneData {
  slices: SliceData[];
  zooms: ZoomData[];
  layouts: unknown[];
  masks: unknown[];
  voiceOvers: unknown[];
}

export const stateCommand = new Command("state")
  .description("Get full project state snapshot")
  .option("--slices", "Show only slices")
  .option("--zooms", "Show only zooms")
  .option("--masks", "Show only masks")
  .option("--layouts", "Show only camera layouts")
  .option("--config", "Show only config")
  .option("--recording", "Show only recording metadata")
  .action(async (opts, cmd) => {
    const json = globals(cmd).json;
    const state = await evaluate<Record<string, unknown>>(cmd, STATE_EXPRESSION);
    const scene = (state.scenes as SceneData[])[0];

    if (opts.slices) return json ? output(scene?.slices ?? [], true) : printSliceTable(scene?.slices ?? []);
    if (opts.zooms) return json ? output(scene?.zooms ?? [], true) : printZoomTable(scene?.zooms ?? []);
    if (opts.masks) return output(scene?.masks ?? [], json);
    if (opts.layouts) return output(scene?.layouts ?? [], json);
    if (opts.config) return output(state.config, json);
    if (opts.recording) return output(state.recording, json);
    if (json) return output(state, true);

    const proj = state.project as Record<string, unknown>;
    console.log(`Project: ${proj.name}`);
    console.log(`Path: ${proj.path}`);
    console.log(`Duration: ${formatMs(proj.durationMs as number)}`);
    console.log(`Dirty: ${proj.isDirty}`);
    if (scene) {
      console.log();
      console.log(`Slices (${scene.slices.length}):`);
      printSliceTable(scene.slices);
      console.log();
      console.log(`Zooms (${scene.zooms.length}):`);
      printZoomTable(scene.zooms);
      console.log();
      console.log(`Layouts: ${scene.layouts.length} | Masks: ${scene.masks.length} | Voiceovers: ${scene.voiceOvers.length}`);
    }
    const rec = state.recording as Record<string, unknown> | null;
    if (rec) {
      console.log();
      console.log(`Recording: ${formatMs(rec.durationMs as number)} | ${rec.keystrokeCount} keystrokes | ${rec.mouseEventCount} mouse events`);
    }
  });

export function printSliceTable(slices: SliceData[]) {
  table(
    ["Slice", "Source Range", "Playback Range", "Speed", "Volume"],
    slices.map((s) => [
      String(s.index),
      `${s.sourceStartMs}ms - ${s.sourceEndMs}ms`,
      `${s.playbackStartMs}ms - ${s.playbackEndMs}ms`,
      `${s.speed}x`,
      String(s.volume),
    ]),
  );
}

export function printZoomTable(zooms: ZoomData[]) {
  table(
    ["ID", "Type", "Presentation", "Zoom", "Source Range", "Disabled"],
    zooms.map((z) => [
      String(z.id),
      String(z.type),
      String(z.presentation),
      `${z.zoom}x`,
      `${z.sourceStartMs}ms - ${z.sourceEndMs}ms`,
      z.isDisabled ? "yes" : "no",
    ]),
  );
}
