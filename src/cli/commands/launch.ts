import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { findRendererPage } from "../../cdp/page-finder.js";
import { output } from "../format.js";
import { numberValue } from "../validation.js";

export const OFFICIAL_BUNDLE_ID = "com.timpler.screenstudio";

export interface AppBundle {
  bundleId: string;
  openArgs: string[];
}

// Builds of Screen Studio can share the "Screen Studio" name, so address the app by its
// bundle identifier. --app or SCREENSTUDIO_APP selects another bundle, such as a beta.
export function appBundle(app?: string): AppBundle {
  const target = app ?? process.env.SCREENSTUDIO_APP;
  if (!target) return { bundleId: OFFICIAL_BUNDLE_ID, openArgs: ["-b", OFFICIAL_BUNDLE_ID] };
  const path = resolve(target);
  const plist = join(path, "Contents", "Info.plist");
  if (!existsSync(plist)) throw new Error(`Not a macOS app bundle: ${path}`);
  const bundleId = execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", plist], { encoding: "utf8" }).trim();
  return { bundleId, openArgs: ["-a", path] };
}

export const launchCommand = new Command("launch")
  .description("Launch Screen Studio with remote debugging, or reuse its existing connection")
  .option("--port <port>", "CDP port (overrides the global option)")
  .option("--app <path>", "Screen Studio app bundle (default: the official app, or SCREENSTUDIO_APP)")
  .option("--restart", "Quit and relaunch an existing Screen Studio instance")
  .action(async (opts, cmd) => {
    const global = cmd.optsWithGlobals();
    const port = numberValue(String(opts.port ?? global.port), "CDP port", 1, 65535);
    if (!Number.isInteger(port)) throw new Error("CDP port must be an integer.");
    const app = appBundle(opts.app);
    if (!opts.restart) {
      try {
        await findRendererPage(port);
        output({ success: true, port, message: "Reusing Screen Studio's existing debugging connection" }, global.json);
        return;
      } catch { /* Check the running app before attempting to launch. */ }
    }

    const running = execFileSync("osascript", ["-e", `application id "${app.bundleId}" is running`], { encoding: "utf8" }).trim() === "true";
    if (running && !opts.restart) {
      throw new Error("Screen Studio is running without an accessible debugging connection on this port. Use its existing --port, or save your work and run screenstudio launch --restart.");
    }
    if (running) {
      execFileSync("osascript", ["-e", `quit app id "${app.bundleId}"`]);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    execFileSync("open", [...app.openArgs, "--args", `--remote-debugging-port=${port}`]);
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      try {
        await findRendererPage(port);
        output({ success: true, port, message: "Screen Studio debugging connection ready" }, global.json);
        return;
      } catch { /* The renderer may still be loading. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Screen Studio launched but its debugging endpoint did not become ready.");
  });
