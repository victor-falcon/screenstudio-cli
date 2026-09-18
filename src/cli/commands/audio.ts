import { Command } from "commander";
import { resolve } from "node:path";
import { withClient } from "../../cdp/client.js";
import { output } from "../format.js";
import { PROJECT, numberValue } from "../validation.js";
import { configPatchExpression } from "./config.js";

const AUDIO_KEYS = [
  "audioVolume", "muteMicrophone", "muteSystemAudio", "muteExternalDeviceAudio",
  "improveMicrophoneAudio", "microphoneInStereoMode", "backgroundAudioFileName",
  "muteBackgroundAudio", "backgroundAudioVolume", "clickSoundEffect", "clickSoundEffectVolume",
];

const audioInfo = new Command("info")
  .description("Show microphone, system, device, background, and click audio settings")
  .action(async (_opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    output(await withClient(Number(opts.port), client => client.evaluate(`${PROJECT}
      return Object.fromEntries(${JSON.stringify(AUDIO_KEYS)}
        .filter(function(key) { return key in p.config; })
        .map(function(key) { return [key, p.config[key]]; }));
    `)), opts.json);
  });

const audioLibrary = new Command("library")
  .description("List Screen Studio's built-in background audio tracks")
  .action(async (_opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    output(await withClient(Number(opts.port), client => client.evaluate(`
      return await bridge.client.query('backgroundAudio.builtInTracks');
    `)), opts.json);
  });

const audioAdd = new Command("add")
  .description("Copy an audio file into the project and use it as background music")
  .argument("<path>", "Path to an audio file (or a path from audio library)")
  .option("--volume <n>", "Background volume (0-1)")
  .action(async (path, opts, cmd) => {
    const global = cmd.optsWithGlobals();
    const volume = opts.volume === undefined ? undefined : numberValue(opts.volume, "Volume", 0, 1);
    output(await withClient(Number(global.port), client => client.evaluate(`${PROJECT}
      if (!('backgroundAudioFileName' in p.config) || typeof p.updateConfig !== 'function')
        throw new Error('Background audio is unavailable in this Screen Studio build.');
      var fileName = await bridge.client.mutation('project.copyFileToProject', {
        projectPath: p.path, sourcePath: ${JSON.stringify(resolve(path))}
      });
      if (typeof fileName !== 'string' || !fileName) throw new Error('Screen Studio did not return an audio asset name.');
      p.updateConfig({ backgroundAudioFileName: fileName, muteBackgroundAudio: false,
        ${volume === undefined ? "" : `backgroundAudioVolume: ${volume}`}
      });
      return { success: true, fileName: fileName, volume: p.config.backgroundAudioVolume };
    `)), global.json);
  });

const audioRemove = new Command("remove")
  .description("Detach background music from the project (keeps the asset for undo)")
  .action(async (_opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    output(await withClient(Number(opts.port), client => client.evaluate(
      configPatchExpression({ backgroundAudioFileName: null }),
    )), opts.json);
  });

export const audioCommand = new Command("audio")
  .description("Inspect audio settings and manage background music")
  .addCommand(audioInfo).addCommand(audioLibrary).addCommand(audioAdd).addCommand(audioRemove);
