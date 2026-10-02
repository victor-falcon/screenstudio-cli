# Screen Studio compatibility

Audited on **2026-10-02** against the installed macOS app **4.0.1-4897** (Electron 43). Screen Studio 4 rewrote the internals this CLI drives, so this version of the CLI does not support 3.x; for Screen Studio 3.7.5, use [rorz/screenstudio-cli](https://github.com/rorz/screenstudio-cli), audited against that build.

This CLI uses private renderer models, the app's command-menu actions, and IPC. Live checks used disposable copies of real projects (a 13-minute, 29-slice recording with camera, microphone and a verbatim ElevenLabs transcript, and a 3-second recording). Run `screenstudio doctor` with a project open to inspect your runtime; its capability checks alone do not prove that every workflow works.

## What changed in Screen Studio 4

| 3.7 | 4.0 | CLI |
| --- | --- | --- |
| `window.$project` (active project) | Removed. `window.$projects` (MobX set) and `window.$$focused` (focused editor) | Picks the focused project, the only open one, or `--project` |
| One renderer page with `index.html` | Main window plus a hidden render worker, both `index.html`; editor windows are `about:blank` children of the main window | Connects to the page that registers `$projects` |
| `scene.zoomRanges`, `scene.update({ zoomRanges })`, `addMask`/`updateMask` | One collection API for slices, zooms, masks, layouts and voiceovers (`add`, `get`, `splitAt`, `findAt`, `remove`, `removeAll`); items cannot overlap | All timeline commands use the collections |
| Flat config (~70 keys) | Grouped config: `crop`, `cursor`, `captions`, `audio`, `camera`, `animations`, `processing`, `zooms`, `defaultLayout`, `styles`, `device`, `output`. `p.config` holds circular references; read `projectConfig.serialize()`, write `updateConfig({ group: partial })` | `config group.key[.subkey]`; old flat keys fail with the new path as a hint |
| Zoom types `manual`/`auto` | `manual`, `follow-mouse` (auto), `follow-click-groups`; `presentation: screen \| loupe` and `loupeOptions` (Glass Loupe) | `zoom --type`, `--loupe`, `--radius`, `--bevel`, `--aberration`, `--no-glass`; `auto` stays an alias |
| Save with `rawData` | `serialize()` + `project.updateProject` + `markAsJustSaved(editGeneration)` | Runs the app's `saveProject` action |
| Pixi preview canvas | New GPU render engine; `editor.animation.exportImage({ heightPx })` returns a PNG of the frame | `preview` uses `exportImage`; `seek` uses `playback.goTo` |
| Export dialog only | `editor.exportManager.startExport(config)` | `export` with format/FPS/resolution/quality/codec; `--output` without a dialog |
| Captions only | **Edit by transcript**: cut words from the video, hide them from captions, restore, correct text, remove fillers, tighten pauses | `transcript` commands |

## Feature coverage

| Feature | CLI coverage |
| --- | --- |
| Edit by transcript | `transcript cut/restore/hide/unhide/fix` by token range or `--text`; `transcript text` + `apply` / `edit` to edit the video as a text file |
| Filler words and pauses | `transcript fillers [--remove] [--language es]`, `transcript pauses [--tighten]` |
| Transcript generation | `transcript generate --engine whisper\|system\|elevenlabs` with `--language`, `--model`, `--prompt`, `--locale`, `--keyterms`, `--verbatim` |
| SRT export | `transcript srt <path>`, with the video's cuts applied and hidden words removed, like the app's export |
| Glass Loupe zooms | `zoom add/update --loupe` and lens options; `action run toggleZoomLoupeMode --zoom <id>` |
| Camera layouts | `layout list/add/update/remove/clear` |
| Masks | `mask list/add/update/remove/clear` |
| Slices | `slice list/split/remove/speed/update/merge/trim` |
| Config | `config --list`, `--flat`, read and write by path |
| Background music | `audio library/add/remove/info` |
| Frame rendering | `preview` (native renderer), `render`/`analyze` (ffmpeg, offline) |
| Export | `export` (dialog for the path), `--output <path>`, `--clipboard`, `--wait`, `--picker` |
| Every command-menu action | `action list`, `action run <id> [--zoom/--mask/--slice/--layout <id>]` |
| Recording | `record start/pause/resume/stop/cancel`, display and window pickers |

## Behavioral notes

- **Transcript controller.** The "Edit by transcript" controller exists while its sidebar panel is mounted. Transcript commands open the panel, take the controller from the React tree, and restore the sidebar root, item, and visibility the user had. Edits use the controller's own methods (`deleteTokens`, `restoreTarget`, `setCoveredWordsHidden`, `applyWordRangeReplacement`, `replaceCoveredWordsWithText`, `removeAllFillerWords`, `tightenAllPauses`), so cuts get the app's padding around kept words, remove zooms/layouts/masks left without footage, and refuse to remove the whole video.
- **Stale indexes.** Commands that take token indexes read the transcript first and refuse to edit if its token count changed before the edit (another edit in the app, a regenerated transcript).
- **Text corrections are saved by the app.** After a correction the app writes the transcript file (`captions.updateTranscript`) 800ms later. Keep Screen Studio running for that long.
- **`transcript apply` semantics.** Words deleted with nothing typed in their place are cut. Where words were deleted and others typed, the typed words replace the deleted words they resemble most (letters and digits, similarity ≥ 0.7: typos, merged or split words, punctuation) and the rest are cut; if they resemble none, the whole stretch is a caption rewrite and nothing is cut. Use `--dry-run` to review, `--cuts-only` to ignore corrections.
- **Filler words.** Screen Studio picks its filler list from the transcript's locale. ElevenLabs transcripts have none, so the app uses its English list (*um*, *uh*...) even for Spanish speech. `--language` uses the CLI's lists. The Spanish list leaves out *este*, which Screen Studio counts as a filler but is usually the demonstrative ("este modelo").
- **Export output path.** With a file target, Screen Studio always asks for the path in a native save dialog and does not report the chosen path. `--output` uses the clipboard target, which needs no dialog, finds the new file in Screen Studio's clipboard exports folder (`$TMPDIR/Screen Studio/Clipboard Exports`) and copies it to the path. That also copies the video to the clipboard.
- **Undo.** Edits within 100ms form one undo step, so each command is one step. `project info`, `undo` and `redo` flush the buffer first.
- **Projects and editors.** With several projects open, commands use the focused editor's project unless `--project` names one (path, file name, or project name). Commands that need an editor (seek, preview, export, transcript, actions, save) fail if the project's editor window is closed.
- **App bundle.** `launch` and `project open` address Screen Studio by bundle identifier (`com.timpler.screenstudio`), so other builds named "Screen Studio" are not picked by mistake. Use `--app <path>` or `SCREENSTUDIO_APP` for those.
- **Recordings are HLS.** Screen Studio 4 records each channel as an HLS playlist (`.m3u8` + fMP4 segments) in limited-range YUV. `render` converts frames to full range before JPEG encoding.

## Validation

Run `npm test`. Tests cover CDP/IPC failures, main-window discovery with a render worker, project and editor selection, timeline collections (splits, range removal, overlap refusal, undo grouping), loupe options, grouped config paths, the transcript controller lookup and sidebar restore, transcript cuts and corrections, the text-edit planner and its word diff, export settings, actions with targets, seek and preview, and real ffmpeg extraction when ffmpeg is installed. They use a small contract fixture of the 4.0 models, not an emulation of the app.

Live checks on **2026-10-02**, using **4.0.1-4897**:

- `doctor` reported every capability available with the long project open; 199 actions.
- Cut a sentence by `--text` (2.46s removed, matching the app's padding), undid it; restored a sentence the user had cut; hid and unhid words; corrected a word and confirmed the corrected transcript on disk.
- Exported the transcript as text, deleted a sentence and a paragraph and merged two words, applied it (2 cuts, 15.9s, and 1 correction), and undid it all with one `project undo`.
- Removed 14 Spanish filler words with `--language es` (2.8s) and undid it.
- Exported captions as SRT.
- Added a Glass Loupe zoom with a custom radius, changed it to a follow-mouse screen zoom, split it, toggled loupe mode through `action run --zoom`; added and edited masks and camera layouts; split, trimmed, sped up, merged and removed slices; changed nested config; undid everything (18 steps).
- Saved through the app's action and confirmed the change on disk.
- Seeked by playback and by source time; rendered 1280×720 PNG frames with `preview`.
- Exported the 3-second project with `--output` at 720p/30fps/web-low and verified a 1280×720, 30fps H.264 + AAC MP4 of 3.35s with ffprobe.
- Ran `analyze` and `render` against an HLS recording.
- Worked with two projects open, with and without `--project`.

Not exercised live: transcript generation (it replaces the transcript; ElevenLabs uploads the audio), `pauses --tighten` and the app's own `fillers --remove` (the test project had nothing to tighten or remove), `export` with the save dialog and `--wait`, and recording (`record` still uses the 3.7 approach: the menu's record handlers, which the 4.0 menu still exposes, and the `capture.*` IPC routes, which still exist).
