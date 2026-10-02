import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { evaluate, globals } from "../context.js";
import { output } from "../format.js";
import { numberValue } from "../validation.js";
import { configPatchExpression } from "./config.js";

const audioInfo = new Command("info")
  .description("Show microphone, system, device, background, and click audio settings")
  .action(async (_opts, cmd) => {
    output(await evaluate(cmd, `return ss.project().projectConfig.serialize().audio;`), globals(cmd).json);
  });

const audioLibrary = new Command("library")
  .description("List Screen Studio's built-in background audio tracks")
  .action(async (_opts, cmd) => {
    output(await evaluate(cmd, `return await bridge.client.query('backgroundAudio.builtInTracks');`), globals(cmd).json);
  });

const audioAdd = new Command("add")
  .description("Copy an audio file into the project and use it as background music")
  .argument("<path>", "Path to an audio file (or a path from audio library)")
  .option("--volume <n>", "Background volume (0-1)")
  .action(async (path, opts, cmd) => {
    const volume = opts.volume === undefined ? undefined : numberValue(opts.volume, "Volume", 0, 1);
    const source = resolve(path);
    if (!existsSync(source)) throw new Error(`Audio file not found: ${source}`);
    output(await evaluate(cmd, `
      var p = ss.project();
      var fileName = await bridge.client.mutation('project.copyFileToProject', {
        projectPath: p.path, sourcePath: ${JSON.stringify(source)}
      });
      if (typeof fileName !== 'string' || !fileName) throw new Error('Screen Studio did not return an audio asset name.');
      var audio = { backgroundAudioFileName: fileName, muteBackgroundAudio: false };
      ${volume === undefined ? "" : `audio.backgroundAudioVolume = ${volume};`}
      p.updateConfig({ audio: audio });
      var after = p.projectConfig.serialize().audio;
      return { success: true, fileName: after.backgroundAudioFileName, volume: after.backgroundAudioVolume };
    `), globals(cmd).json);
  });

const audioRemove = new Command("remove")
  .description("Detach background music from the project (keeps the asset for undo)")
  .action(async (_opts, cmd) => {
    output(await evaluate(cmd, configPatchExpression({ "audio.backgroundAudioFileName": null })), globals(cmd).json);
  });

export const audioCommand = new Command("audio")
  .description("Inspect audio settings and manage background music")
  .addCommand(audioInfo).addCommand(audioLibrary).addCommand(audioAdd).addCommand(audioRemove);
