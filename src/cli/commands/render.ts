import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "fs";
import { withClient } from "../../cdp/client.js";
import { output } from "../format.js";
import { RECORDING_VIDEO } from "../recording.js";
import { numberValue, timeRange, PROJECT_LOOKUP } from "../validation.js";

interface ZoomRange {
  id: string;
  zoom: number;
  sourceStartTime: number;
  sourceEndTime: number;
  isDisabled: boolean;
  manualTargetPoint: { x: number; y: number } | null;
}

interface SliceInfo {
  sourceStartMs: number;
  sourceEndMs: number;
}

export const renderCommand = new Command("render")
  .description(
    "Render preview frames from the raw video with zoom crop applied",
  )
  .option("--fps <n>", "Frames per second", "5")
  .option("--from <ms>", "Start time in source ms")
  .option("--to <ms>", "End time in source ms")
  .option("-o, --output <dir>", "Output directory", "/tmp/screenstudio-render")
  .action(async (opts, cmd) => {
    const port = parseInt(cmd.parent?.opts().port || "9222");
    const json = cmd.parent?.opts().json || false;
    const fps = numberValue(opts.fps, "FPS");
    if (fps <= 0) throw new Error("FPS must be greater than zero.");
    const outputDir = opts.output;

    // Check ffmpeg and ffprobe
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    } catch {
      console.error(
        "ffmpeg and ffprobe are required. Install: brew install ffmpeg",
      );
      process.exit(1);
    }

    // Get project state
    const info = await withClient(port, async (client) => {
      return client.evaluate<{
        recordingPath: string;
        videoPath: string;
        durationMs: number;
        zooms: ZoomRange[];
        slices: SliceInfo[];
      }>(`
        ${PROJECT_LOOKUP}
        if (!p) return { error: 'No project open' };
        var scene = p.scenes[0];
        if (!scene) return { error: 'No scene' };
        ${RECORDING_VIDEO}
        return {
          videoPath: videoPath,
          recordingPath: p.recording.recordingPath,
          durationMs: Math.round(p.recording.durationMs),
          zooms: scene.zoomRanges.map(function(z) {
            return {
              id: z.id,
              zoom: z.zoom,
              sourceStartTime: Math.round(z.sourceStartTime),
              sourceEndTime: Math.round(z.sourceEndTime),
              isDisabled: z.isDisabled,
              manualTargetPoint: z.manualTargetPoint || null,
            };
          }),
          slices: scene.slices.map(function(s) {
            return {
              sourceStartMs: Math.round(s.sourceStartMs),
              sourceEndMs: Math.round(s.sourceEndMs),
            };
          }),
        };
      `);
    });

    const videoPath = info.videoPath;

    // Get actual video dimensions via ffprobe
    const probeOutput = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", videoPath,
    ], { encoding: "utf8" }).trim();
    const [videoWidth, videoHeight] = probeOutput.split(",").map(Number);

    if (!videoWidth || !videoHeight) {
      console.error(`Could not determine video dimensions from: ${videoPath}`);
      process.exit(1);
    }

    // Create output directory
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    // Determine time range
    const fromMs = opts.from !== undefined ? numberValue(opts.from, "Start time") : 0;
    const toMs = opts.to !== undefined ? numberValue(opts.to, "End time") : info.durationMs;
    timeRange(fromMs, toMs);

    // Filter slices to the requested range
    const relevantSlices = info.slices.filter(
      (s) => s.sourceEndMs > fromMs && s.sourceStartMs < toMs,
    );

    if (relevantSlices.length === 0) {
      console.error("No slices in the requested time range.");
      process.exit(1);
    }

    // Active (non-disabled) zooms
    const activeZooms = info.zooms.filter((z) => !z.isDisabled);

    // Find the active zoom at a given source time
    function getZoomAt(timeMs: number): ZoomRange | null {
      for (const z of activeZooms) {
        if (timeMs >= z.sourceStartTime && timeMs < z.sourceEndTime) {
          return z;
        }
      }
      return null;
    }

    // Calculate crop filter for a zoom
    function getCropFilter(zoom: ZoomRange | null): string {
      if (!zoom || zoom.zoom <= 1) {
        return `crop=${videoWidth}:${videoHeight}:0:0`;
      }

      const z = zoom.zoom;
      const cropW = Math.round(videoWidth / z);
      const cropH = Math.round(videoHeight / z);

      const targetX = zoom.manualTargetPoint?.x ?? 0.5;
      const targetY = zoom.manualTargetPoint?.y ?? 0.5;

      const centerX = targetX * videoWidth;
      const centerY = targetY * videoHeight;

      let cropX = Math.round(centerX - cropW / 2);
      let cropY = Math.round(centerY - cropH / 2);

      // Clamp to video bounds
      cropX = Math.max(0, Math.min(cropX, videoWidth - cropW));
      cropY = Math.max(0, Math.min(cropY, videoHeight - cropH));

      return `crop=${cropW}:${cropH}:${cropX}:${cropY}`;
    }

    if (!json) {
      console.log(`Video: ${videoWidth}x${videoHeight}`);
      console.log(`Time range: ${fromMs}ms - ${toMs}ms`);
      console.log(`FPS: ${fps}, Output: ${outputDir}/`);
      console.log(`Active zooms: ${activeZooms.length}`);
    }

    let totalFrames = 0;

    // Group consecutive time ranges by their active zoom to batch ffmpeg calls
    interface Segment {
      startMs: number;
      endMs: number;
      zoom: ZoomRange | null;
    }

    const segments: Segment[] = [];

    for (const slice of relevantSlices) {
      const sliceStart = Math.max(slice.sourceStartMs, fromMs);
      const sliceEnd = Math.min(slice.sourceEndMs, toMs);

      // Walk through the slice splitting at zoom boundaries
      let t = sliceStart;
      while (t < sliceEnd) {
        const zoom = getZoomAt(t);
        // Find the end of this zoom's applicability within this slice
        let segEnd = sliceEnd;
        if (zoom) {
          segEnd = Math.min(segEnd, zoom.sourceEndTime);
        } else {
          // Find next zoom start
          for (const z of activeZooms) {
            if (z.sourceStartTime > t && z.sourceStartTime < segEnd) {
              segEnd = z.sourceStartTime;
            }
          }
        }
        segments.push({ startMs: t, endMs: segEnd, zoom });
        t = segEnd;
      }
    }

    // Render each segment
    for (const seg of segments) {
      const cropFilter = getCropFilter(seg.zoom);
      const fromSec = seg.startMs / 1000;
      const toSec = seg.endMs / 1000;
      const segFrames = Math.ceil(
        ((seg.endMs - seg.startMs) / 1000) * fps,
      );

      if (segFrames <= 0) continue;

      const startIdx = totalFrames + 1;
      const zoomLabel = seg.zoom
        ? `zoom=${seg.zoom.zoom}x`
        : "no zoom";

      if (!json) console.log(
        `Rendering ${segFrames} frames [${seg.startMs}ms-${seg.endMs}ms] (${zoomLabel})`,
      );

      const ffmpegArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-ss",
        String(fromSec),
        "-to",
        String(toSec),
        "-i",
        videoPath,
        "-vf",
        `${cropFilter},fps=${fps}`,
        "-q:v",
        "3",
        "-start_number",
        String(startIdx),
        `${outputDir}/frame_%04d.jpg`,
        "-y",
      ];

      const progress = execFileSync("ffmpeg", ffmpegArgs, { encoding: "utf8" });
      const frameCounts = [...progress.matchAll(/^frame=(\d+)\s*$/gm)];
      const lastCount = frameCounts.at(-1);
      if (!lastCount) throw new Error("ffmpeg did not report the number of rendered frames.");
      // fps rounds at segment boundaries. Use the emitted count so subsequent
      // segments continue without gaps or overwriting earlier frames.
      totalFrames += Number(lastCount[1]);
    }

    const result = {
      outputDir,
      totalFrames,
      videoWidth,
      videoHeight,
      fps,
      fromMs,
      toMs,
      segments: segments.length,
    };

    if (json) {
      output(result, true);
    } else {
      console.log();
      console.log(
        `Done. Rendered ${totalFrames} frames to ${outputDir}/`,
      );
    }
  });
