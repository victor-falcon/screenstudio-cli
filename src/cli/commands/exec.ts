import { Command } from "commander";
import { readFileSync } from "fs";
import { withClient } from "../../cdp/client.js";
import { evaluate, globals } from "../context.js";

export const execCommand = new Command("exec")
  .description("Execute arbitrary JavaScript inside Screen Studio's main window")
  .argument("[expression]", "JavaScript expression to evaluate")
  .option("-f, --file <path>", "Read script from file")
  .option("--runtime", "Run the script as an async function body with the CLI's `ss` helpers (ss.project(), ss.editor(), ss.transcriptEditor()...); return a JSON value")
  .action(async (expression, opts, cmd) => {
    let script: string;
    if (opts.file) {
      script = readFileSync(opts.file, "utf-8");
    } else if (expression === "-" || !expression) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      script = Buffer.concat(chunks).toString("utf-8").trim();
    } else {
      script = expression;
    }
    if (!script) throw new Error("Provide an expression, --file, or pipe to stdin");

    if (opts.runtime) {
      console.log(JSON.stringify(await evaluate(cmd, script, 120_000), null, 2));
      return;
    }
    const result = await withClient(globals(cmd).port, client => client.evaluateRaw(script));
    try {
      console.log(JSON.stringify(JSON.parse(result), null, 2));
    } catch {
      console.log(result);
    }
  });
