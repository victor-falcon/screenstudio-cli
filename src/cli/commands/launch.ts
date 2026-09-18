import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { findRendererPage } from "../../cdp/page-finder.js";
import { output } from "../format.js";
import { numberValue } from "../validation.js";

export const launchCommand = new Command("launch")
  .description("Launch Screen Studio with remote debugging, or reuse its existing connection")
  .option("--port <port>", "CDP port (overrides the global option)")
  .option("--restart", "Quit and relaunch an existing Screen Studio instance")
  .action(async (opts, cmd) => {
    const global = cmd.optsWithGlobals();
    const port = numberValue(opts.port ?? global.port, "CDP port", 1, 65535);
    if (!Number.isInteger(port)) throw new Error("CDP port must be an integer.");
    if (!opts.restart) {
      try {
        await findRendererPage(port);
        output({ success: true, port, message: "Reusing Screen Studio's existing debugging connection" }, global.json);
        return;
      } catch { /* Check the running app before attempting to launch. */ }
    }

    const running = execFileSync("osascript", ["-e", 'application "Screen Studio" is running'], { encoding: "utf8" }).trim() === "true";
    if (running && !opts.restart) {
      throw new Error("Screen Studio is running without an accessible debugging connection on this port. Use its existing --port, or save your work and run screenstudio launch --restart.");
    }
    if (running) {
      execFileSync("osascript", ["-e", 'quit app "Screen Studio"']);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    execFileSync("open", ["-a", "Screen Studio", "--args", `--remote-debugging-port=${port}`]);
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      try {
        await findRendererPage(port);
        output({ success: true, port, message: "Screen Studio debugging connection ready" }, global.json);
        return;
      } catch { /* The renderer may still be loading. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Screen Studio launched but its debugging endpoint did not become ready.");
  });
