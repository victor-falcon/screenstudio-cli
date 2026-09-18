import { Command } from "commander";
import { launchCommand } from "./commands/launch.js";
import { statusCommand } from "./commands/status.js";
import { execCommand } from "./commands/exec.js";
import { stateCommand } from "./commands/state.js";
import { configCommand } from "./commands/config.js";
import { sliceCommand } from "./commands/slice.js";
import { zoomCommand } from "./commands/zoom.js";
import { projectCommand } from "./commands/project.js";
import { analyzeCommand } from "./commands/analyze.js";
import { exportCommand } from "./commands/export.js";
import { previewCommand } from "./commands/preview.js";
import { seekCommand } from "./commands/seek.js";
import { maskCommand } from "./commands/mask.js";
import { renderCommand } from "./commands/render.js";
import { recordCommand } from "./commands/record.js";
import { audioCommand } from "./commands/audio.js";
import { doctorCommand } from "./commands/doctor.js";

const program = new Command("screenstudio")
  .description("Control Screen Studio from the command line")
  .version("0.1.0")
  .option("--json", "Output as JSON", false)
  .option("--port <port>", "CDP port", "9222");

program.addCommand(launchCommand);
program.addCommand(statusCommand);
program.addCommand(execCommand);
program.addCommand(stateCommand);
program.addCommand(configCommand);
program.addCommand(sliceCommand);
program.addCommand(zoomCommand);
program.addCommand(projectCommand);
program.addCommand(analyzeCommand);
program.addCommand(exportCommand);
program.addCommand(previewCommand);
program.addCommand(seekCommand);
program.addCommand(maskCommand);
program.addCommand(renderCommand);
program.addCommand(recordCommand);
program.addCommand(audioCommand);
program.addCommand(doctorCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
