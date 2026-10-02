import { Command } from "commander";
import { evaluate, globals } from "../context.js";
import { output, formatMs } from "../format.js";

interface ProjectSummary {
  name: string;
  path: string;
  durationMs: number;
  sliceCount: number;
  isDirty: boolean;
  isFocused: boolean;
}

interface StatusResult {
  version: string;
  projects: ProjectSummary[];
}

export const STATUS_EXPRESSION = `
  var focused = window.$$focused && window.$$focused.project;
  return {
    version: typeof electronEnv !== 'undefined' ? electronEnv.APP_VERSION : 'unknown',
    projects: ss.projects().map(function (p) {
      return { name: p.name, path: p.path, durationMs: Math.round(p.playbackDurationMs),
        sliceCount: p.scene ? p.scene.slices.length : 0, isDirty: p.isDirty, isFocused: p === focused };
    }),
  };
`;

export const statusCommand = new Command("status")
  .description("Check the connection and list open projects")
  .action(async (_opts, cmd) => {
    const result = await evaluate<StatusResult>(cmd, STATUS_EXPRESSION);
    if (globals(cmd).json) return output(result, true);
    if (!result.projects.length) {
      console.log(`Connected to Screen Studio ${result.version} | No project open`);
      return;
    }
    console.log(`Connected to Screen Studio ${result.version}`);
    for (const p of result.projects) {
      console.log(
        `${p.isFocused && result.projects.length > 1 ? "* " : ""}Project: ${p.name} | ` +
          `Duration: ${formatMs(p.durationMs)} | ${p.sliceCount} slices` +
          (p.isDirty ? " (unsaved)" : ""),
      );
    }
  });
