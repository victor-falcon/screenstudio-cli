import { PROJECT_LOOKUP } from "../validation.js";
import { Command } from "commander";
import { withClient } from "../../cdp/client.js";
import { output, formatMs, table } from "../format.js";

export const STATE_EXPRESSION = `
  ${PROJECT_LOOKUP}
  if (!p) throw new Error('No project open');
  var scenes = p.scenes.map(function(scene) {
    return {
      id: scene.id, name: scene.name,
      slices: scene.slices.map(function(s) {
        return {
          id: s.id, index: s.index,
          sourceStartMs: Math.round(s.sourceStartMs), sourceEndMs: Math.round(s.sourceEndMs),
          playbackStartMs: Math.round(s.playbackStartMs), playbackEndMs: Math.round(s.playbackEndMs),
          speed: s.speed, volume: s.volume, hideCursor: s.hideCursor,
          systemAudioVolume: s.systemAudioVolume, externalDeviceAudioVolume: s.externalDeviceAudioVolume,
          disableSmoothMouseMovement: s.disableSmoothMouseMovement,
        };
      }),
      zoomRanges: scene.zoomRanges.map(function(z) {
        return {
          ...z.data, sourceStartTime: z.sourceStartTime, sourceEndTime: z.sourceEndTime,
          duration: z.duration, isAuto: z.isAuto, isManual: z.isManual,
          manualTargetPoint: z.manualTargetPoint, hasInstantAnimation: z.hasInstantAnimation,
        };
      }),
      masks: (scene.masks || []).map(function(m) { return m.data; }),
      layouts: (scene.layouts || []).map(function(l) { return l.data; }),
      voiceOvers: (scene.voiceOvers || []).map(function(v) { return v.data; }),
    };
  });
  var rec = p.recording;
  var recording = rec ? {
    durationMs: Math.round(rec.durationMs), path: rec.recordingPath,
    hasCamera: rec.hasCamera, hasAudio: rec.hasAudio, hasCursor: rec.hasCursor,
    hasKeystrokes: rec.hasKeystrokes, hasMicrophone: rec.hasMicrophone,
    hasSystemAudio: rec.hasSystemAudio, hasExternalDeviceAudio: rec.hasExternalDeviceAudio,
    mode: rec.mode, keystrokeCount: rec.keystrokes?.length || 0,
    mouseEventCount: rec.mouseEvents?.length || 0,
    sessions: (rec.sessions || []).map(function(s) {
      return { recordingStartMs: s.recordingStartMs, durationMs: s.durationMs,
        videoPath: s.recordingVideoPath, microphonePath: s.voiceAudioPath,
        systemAudioPath: s.systemAudioPath, externalDeviceAudioPath: s.externalDeviceAudioPath };
    }),
  } : null;
  return {
    project: { name: p.name, id: p.id, path: p.path, durationMs: Math.round(p.playbackDurationMs),
      isDirty: p.isDirty, canUndo: p.history?.canUndo, canRedo: p.history?.canRedo, hasAudio: p.hasAudio },
    config: p.config, scenes: scenes, recording: recording,
  };
`;

export const stateCommand = new Command("state")
  .description("Get full project state snapshot")
  .option("--slices", "Show only slices")
  .option("--zooms", "Show only zoom ranges")
  .option("--masks", "Show masks from the first scene")
  .option("--layouts", "Show camera layouts from the first scene")
  .option("--config", "Show only config")
  .option("--recording", "Show only recording metadata")
  .action(async (opts, cmd) => {
    const port = parseInt(cmd.parent?.opts().port || "9222");
    const json = cmd.parent?.opts().json || false;

    const state = await withClient(port, async (client) => {
      return client.evaluate<Record<string, unknown>>(STATE_EXPRESSION);
    });

    if ((state as { error?: string }).error) {
      console.error((state as { error: string }).error);
      process.exit(1);
    }

    // Filter to requested section
    if (opts.slices) {
      const scenes = state.scenes as Array<{ slices: unknown[] }>;
      if (json) output(scenes[0]?.slices || [], true);
      else printSliceTable((scenes[0]?.slices || []) as SliceData[]);
      return;
    }
    if (opts.zooms) {
      const scenes = state.scenes as Array<{ zoomRanges: unknown[] }>;
      output(scenes[0]?.zoomRanges, json);
      return;
    }
    if (opts.masks || opts.layouts) {
      const scenes = state.scenes as Array<Record<string, unknown>>;
      output(scenes[0]?.[opts.masks ? "masks" : "layouts"] || [], json);
      return;
    }
    if (opts.config) {
      output(state.config, json);
      return;
    }
    if (opts.recording) {
      output(state.recording, json);
      return;
    }

    if (json) {
      output(state, true);
    } else {
      // Human-readable summary
      const proj = state.project as Record<string, unknown>;
      console.log(`Project: ${proj.name}`);
      console.log(`Path: ${proj.path}`);
      console.log(`Duration: ${formatMs(proj.durationMs as number)}`);
      console.log(`Dirty: ${proj.isDirty}`);
      console.log();

      const scenes = state.scenes as Array<{
        slices: SliceData[];
        zoomRanges: ZoomData[];
      }>;
      if (scenes[0]) {
        console.log(`Slices (${scenes[0].slices.length}):`);
        printSliceTable(scenes[0].slices);
        console.log();
        console.log(`Zoom Ranges (${scenes[0].zoomRanges.length}):`);
        printZoomTable(scenes[0].zoomRanges);
      }

      const rec = state.recording as Record<string, unknown> | null;
      if (rec) {
        console.log();
        console.log(
          `Recording: ${formatMs(rec.durationMs as number)} | ` +
            `${rec.keystrokeCount} keystrokes | ` +
            `${rec.mouseEventCount} mouse events`,
        );
      }
    }
  });

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
  zoom: unknown;
  sourceStartTime: number;
  sourceEndTime: number;
  isDisabled: boolean;
}

function printSliceTable(slices: SliceData[]) {
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

function printZoomTable(zooms: ZoomData[]) {
  table(
    ["ID", "Type", "Zoom", "Start", "End", "Disabled"],
    zooms.map((z) => [
      String(z.id || "?"),
      String(z.type || "?"),
      typeof z.zoom === "number" ? `${z.zoom}x` : String(z.zoom ?? "?"),
      `${z.sourceStartTime}ms`,
      `${z.sourceEndTime}ms`,
      z.isDisabled ? "yes" : "no",
    ]),
  );
}
