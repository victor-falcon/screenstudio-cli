import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { evaluate, globals } from "../context.js";
import { output } from "../format.js";
import { RECORDING_VIDEO } from "../recording.js";
import { numberValue, timeRange } from "../validation.js";

export const analyzeCommand = new Command("analyze")
  .description("Extract frames and event timeline from recording")
  .option("--interval <seconds>", "Seconds between frames", "5")
  .option("--from <ms>", "Start time in source ms")
  .option("--to <ms>", "End time in source ms")
  .option("-o, --output <dir>", "Output directory", "/tmp/screenstudio-analyze")
  .action(async (opts, cmd) => {
    const json = globals(cmd).json;
    const interval = numberValue(opts.interval, "Interval");
    if (interval <= 0) throw new Error("Interval must be greater than zero.");
    const outputDir = opts.output;

    // Check ffmpeg
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    } catch {
      console.error("ffmpeg is required for analyze. Install: brew install ffmpeg");
      process.exit(1);
    }

    // Get recording info from Screen Studio
    const info = await evaluate<{
      recordingPath: string;
      videoPath: string;
      durationMs: number;
    }>(cmd, `
      var p = ss.project();
      ${RECORDING_VIDEO}
      return { videoPath: videoPath, recordingPath: p.path + '/recording', durationMs: Math.round(p.recording.durationMs) };
    `);

    const videoPath = info.videoPath;

    // Create output directory
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    // Build ffmpeg command
    const fromSec = opts.from !== undefined ? numberValue(opts.from, "Start time") / 1000 : 0;
    const toSec = opts.to !== undefined ? numberValue(opts.to, "End time") / 1000 : info.durationMs / 1000;
    timeRange(fromSec, toSec);

    const ffmpegArgs = [
      "-i",
      videoPath,
      "-ss",
      String(fromSec),
      "-to",
      String(toSec),
      "-vf",
      `fps=1/${interval},scale=640:-1`,
      "-q:v",
      "3",
      `${outputDir}/frame_%03d.jpg`,
      "-y",
    ];

    if (!json) console.log("Extracting frames...");
    execFileSync("ffmpeg", ffmpegArgs, { stdio: "ignore" });

    // Read event data
    const keystrokesPath = `${info.recordingPath}/keystrokes-0.json`;
    const mouseclicksPath = `${info.recordingPath}/mouseclicks-0.json`;

    let keystrokes: Array<{ processTimeMs: number; character: string; type: string }> = [];
    let mouseclicks: Array<{ processTimeMs: number; button: string; x: number; y: number }> = [];

    if (existsSync(keystrokesPath)) {
      keystrokes = JSON.parse(readFileSync(keystrokesPath, "utf-8"));
    }
    if (existsSync(mouseclicksPath)) {
      mouseclicks = JSON.parse(readFileSync(mouseclicksPath, "utf-8"));
    }

    // Build timeline
    const frames: Array<{
      frame: number;
      timeMs: number;
      file: string;
      keystrokes: Array<{ timeMs: number; character: string; type: string }>;
      mouseclicks: Array<{ timeMs: number; button: string; x: number; y: number }>;
    }> = [];

    const startMs = fromSec * 1000;
    let frameNum = 1;

    while (true) {
      const timeMs = startMs + (frameNum - 1) * interval * 1000;
      if (timeMs >= toSec * 1000) break;

      const file = `${outputDir}/frame_${String(frameNum).padStart(3, "0")}.jpg`;
      if (!existsSync(file)) break;

      const windowStart = timeMs;
      const windowEnd = timeMs + interval * 1000;

      frames.push({
        frame: frameNum,
        timeMs,
        file,
        keystrokes: keystrokes
          .filter((k) => k.processTimeMs >= windowStart && k.processTimeMs < windowEnd)
          .map((k) => ({ timeMs: Math.round(k.processTimeMs), character: k.character, type: k.type })),
        mouseclicks: mouseclicks
          .filter((m) => m.processTimeMs >= windowStart && m.processTimeMs < windowEnd)
          .map((m) => ({ timeMs: Math.round(m.processTimeMs), button: m.button, x: Math.round(m.x), y: Math.round(m.y) })),
      });

      frameNum++;
    }

    if (json) {
      output({ frames, totalKeystrokes: keystrokes.length, totalMouseclicks: mouseclicks.length }, true);
    } else {
      console.log(`Extracted ${frames.length} frames to ${outputDir}/`);
      console.log(`Recording: ${keystrokes.length} keystrokes, ${mouseclicks.length} mouse clicks`);
      console.log();

      for (const f of frames) {
        const events: string[] = [];
        for (const k of f.keystrokes) {
          events.push(`key:${k.character || k.type}@${k.timeMs}ms`);
        }
        for (const m of f.mouseclicks) {
          events.push(`click:${m.button}@${m.timeMs}ms(${m.x},${m.y})`);
        }

        console.log(
          `Frame ${f.frame} (${(f.timeMs / 1000).toFixed(1)}s): ${f.file}` +
            (events.length > 0 ? `\n  Events: ${events.join(", ")}` : ""),
        );
      }
    }
  });
