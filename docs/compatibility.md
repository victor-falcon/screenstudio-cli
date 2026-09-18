# Screen Studio compatibility

Audited on **2026-09-16** against the installed macOS app **3.7.5-4595**, the latest stable release listed in the [official changelog](https://screen.studio/changelog) on that date. The releases after 3.6 chiefly fix audio, export, recording, and captions behavior; they do not establish a public automation API.

This CLI uses private renderer models and IPC. The audit checked their shapes in the installed app, added regression tests, and exercised editing, saving, preview, and native file export in the running app using a disposable six-second video project. The validation details below distinguish live checks from features that remain untested. Run `screenstudio doctor` with a project open to inspect your actual runtime; its capability checks alone do not prove that every workflow works.

## Feature coverage

| Feature | CLI coverage |
| --- | --- |
| Apply playback speed to all slices | `slice speed all 2`; includes 24x speed |
| Independent microphone, system, and external-device audio volumes | `slice update <index-or-all> --volume 1 --system-volume 0.5 --device-volume 0` |
| Cursor visibility and smoothing per slice | `slice update <index-or-all> --hide-cursor` / `--show-cursor`, `--raw-cursor` / `--smooth-cursor` |
| Microphone enhancement and stereo | `config improveMicrophoneAudio true`, `config microphoneInStereoMode true` |
| Channel muting | `config muteMicrophone`, `muteSystemAudio`, `muteExternalDeviceAudio`, or `muteBackgroundAudio` with a boolean value |
| Background music and built-in music library | `audio library`, `audio add <path> [--volume 0.1]`, `audio remove`, `audio info` |
| Click sounds and effects | Existing `config clickSoundEffect`, `clickSoundEffectVolume`, and `clickEffect` values exposed by the app |
| Sensitive-data and highlight masks | `mask add --type sensitive-data` or `--type highlight --opacity 0.5`; `mask update --disable` / `--enable` |
| Instant and automatic zooms | `zoom add --instant --type auto`, `zoom update --instant` / `--animated` |
| Current wallpapers, cursor sets, device frames, camera defaults | Runtime `config --list`; the CLI does not hard-code a fixed settings count or asset catalog. Use the app to select an asset, then read its actual config value. |
| Camera layout timeline | Inspect with `state --layouts`; dedicated layout editing remains in the app |
| Captions | Visibility and size via `config showTranscript` and `transcriptSizeRatio`; generation, Apple Speech Recognition selection, transcript editing, and SRT export remain in the app |
| Keyboard shortcut overlays | `config showShortcuts`, `showShortcutsWithSingleLetters`, `shortcutsSizeRatio`, and `hiddenShortcuts` |
| Recording pause/resume | `record pause` and `record resume` await native completion and report failures |
| Recording input selection | Display/window/area picker automation; iPhone/iPad input and camera/microphone device setup remain in the app |
| Frame inspection | `preview` uses the native renderer. `render`/`analyze` use the actual video path from session metadata, including window/device/imported videos. |
| Export | `export` opens the app's dialog; `export --clipboard` triggers quick export. File format, GIF loops, resolution, shareable links, privacy, comments, and view counts remain in the app/dashboard. |
| Reset all trims/cuts | Use the app's command menu; no CLI reset command |

## Behavioral fixes

- Project save sends an object (`rawData`), waits for the write, and marks saved only after success. Project open uses the macOS file-open event; reading a project file over IPC does not open its editor.
- Mask creation uses the model returned by `addMask`. The mask collection is sorted, so its last entry need not be the newly created mask. Updating geometry preserves extra rectangles.
- Model updates participate in the app's undo history. A no-argument `history.update()` is not an undo snapshot in this build. Undo/redo consult the history object and flush pending history before checking availability.
- CDP awaits promises and reports protocol errors, renderer exceptions, disconnections, and timeouts. Recording commands no longer discard native promise rejections.
- `launch` reuses an existing connection. Restarting a running app requires `launch --restart`; a global `--port` is honored.
- Unknown config keys fail instead of silently adding ineffective properties. Settings are discovered from the running version.
- Export opens the active editor's native export picker and checks that it opened. Sending keyboard events to the hidden main renderer did not trigger export in the live app. Clipboard export uses the native menu action.
- Seeking resolves the current project's timeline on every call. Cached callbacks continued to target a closed editor after reopening a project, producing screenshots at the wrong time. Missing timelines and invalid seek times now fail explicitly.
- Screen Studio retains its last project global after closing the editor. The CLI checks the open-project registry so diagnostics, reads, and edits do not treat that closed project as active.
- Slice edits reject malformed numbers, reversed ranges, and ambiguous removal arguments before mutation. Config writes reject non-finite numbers before JSON serialization can turn them into null.
- Offline rendering numbers frames using ffmpeg's actual output count. Fractional slice and zoom boundaries no longer leave gaps between segments or inflate the reported total.
- Preview capture uses the shared CDP error and timeout handling. It reports failed captures without writing an image, supports JSON output, and opens image paths without shell interpolation.

## Limits

Editing commands target the **first scene**; full `state --json` includes all scenes. Offline `render`/`analyze` require a single recording session. They reject paused/resumed recordings with multiple media files instead of treating the first file as the full recording; use `preview` for those projects. `render` is an approximate static crop preview, without native automatic cursor following, spring animation, masks, camera composition, or captions.

Recording picker automation, seeking, export controls, and native canvas preview still depend on React/Pixi internals. `export` confirms that its dialog opened; `export --clipboard` reports that its native action was invoked. Neither command waits for a completed file. Raw `exec`, recording cancellation, file operations, and export are not covered by project undo.

Native preview requires one auxiliary app window. Close other project and recording picker windows before capture; the CLI rejects ambiguous targets rather than capturing an arbitrary window. Seeking still moves the active project's playhead when this prevents its optional preview refresh.

## Beta

The [official roadmap](https://screen.studio/roadmap) lists a new render engine, expanded camera tools, Glass Loupe zoom, revised captions/shortcuts/click effects, AI voice cleanup, and Unsplash backgrounds as beta features. They are outside the stable 3.7.5 audit. Do not assume stable renderer hooks or config keys work in that beta; `doctor` explicitly identifies a different build.

## Validation

Run `npm test`. Tests cover asynchronous CDP/IPC failures, current model data shapes, mask ordering, independent audio channels, undo, state inspection, export dispatch, seeking after a project switch, and real ffmpeg extraction when ffmpeg/ffprobe are installed. These tests do not start or restart Screen Studio. They use a small contract fixture, not a full emulation of the app.

Review on **2026-09-18** added regression coverage for slice input validation, explicit restart dispatch, preview capture ordering and failures, ambiguous preview targets, and actual ffmpeg frame counts across zoom boundaries. These follow-up changes were checked with the automated suite; the live checks below describe the earlier audit.

Live checks on **2026-09-16**, using **3.7.5-4595**:

- All `doctor` capability checks passed with the test project open; the runtime exposed 70 config keys.
- Split a clip, applied 24x speed to all slices, changed independent audio volumes and cursor settings, and verified undo/redo.
- Created sensitive-data and highlight masks in reverse time order, changed geometry and visibility, and inspected native previews. Created an instant automatic zoom and changed it to an animated manual zoom.
- Read the built-in music library, imported a track, changed its volume, detached it, and restored it with undo.
- Saved the project, checked the JSON on disk, and closed/reopened it to verify persistence. Verified seeking and capture after reopening.
- Extracted four frames with each of `analyze` and `render` over a two-second interval.
- Opened the export dialog through the CLI, completed the native Save dialog, and verified a six-second H.264/AAC MP4 at 3472 × 2160 and 60 fps using ffprobe.
- Verified that `export --clipboard` reaches the native clipboard export action with an MP4 configuration. The final export call was intercepted during this check, preserving the existing clipboard; actual clipboard output was not tested.
- Confirmed that `record pause` reports the native error when no recording is active. Active recording start/pause/resume/stop, physical device/camera inputs, captions generation, and beta features were not exercised.
