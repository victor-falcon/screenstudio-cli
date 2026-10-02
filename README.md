# screenstudio-cli

Control [Screen Studio](https://www.screen.studio/) 4 from the command line. No plugins, no extensions — a direct WebSocket connection to the Electron app's MobX models via the Chrome DevTools Protocol.

Record, edit, and export Screen Studio projects from the terminal, including **editing the video by editing its transcript**. Built for scripted workflows and AI agents (Claude Code, Codex, etc.).

> This fork targets **Screen Studio 4** (audited against 4.0.1-4897). Screen Studio 4 replaced the internal models that 3.x versions of this CLI relied on; for Screen Studio 3.7, use [rorz/screenstudio-cli](https://github.com/rorz/screenstudio-cli).

## How It Works

Screen Studio is an Electron app. Launching it with `--remote-debugging-port=9222` exposes the Chrome DevTools Protocol, giving direct access to its React/MobX internals. This CLI connects via WebSocket and can:

- Edit the video through its transcript: cut words, sentences or paragraphs, remove filler words, tighten pauses, fix captions — the same operations as the app's **Edit by transcript** panel
- Turn the transcript into a text file you (or an agent) edit, then apply the deletions as cuts
- Read full project state (slices, zooms, masks, camera layouts, grouped config, recording metadata)
- Mutate the timeline (split, trim, remove, speed up, merge)
- Manage zooms, including **Glass Loupe** zooms, masks and camera layouts
- Export headlessly with explicit format, resolution, FPS and quality, and wait for the file
- Render frames with Screen Studio's own renderer
- Run any of the ~200 actions in the app's command menu by id
- Start/stop/pause recordings

Project edits use Screen Studio's undo-enabled models: every CLI command is one undo step (`screenstudio project undo`). Recording, export, file operations, and arbitrary `exec` scripts are not covered by project undo.

## Requirements

- **Node.js** >= 22 ([WebSocket is enabled by default](https://nodejs.org/api/globals.html#class-websocket))
- **Screen Studio 4** (macOS)
- **ffmpeg** (for `render` and `analyze` commands) — `brew install ffmpeg`

## Compatibility

Audited against **Screen Studio 4.0.1-4897** on 2026-10-02. Editing, transcript editing, save, frame rendering and headless MP4 export were verified live with disposable copies of real projects. Run `screenstudio doctor` with a project open to inspect your runtime. See [feature coverage and validation details](docs/compatibility.md) for what was checked and the remaining limits.

## Install

From source:

```bash
git clone https://github.com/victor-falcon/screenstudio-cli.git
cd screenstudio-cli
npm install
npm run build
npm link
```

## Quick Start

```bash
# Launch Screen Studio with CDP enabled, or reuse its existing connection
screenstudio launch
# If already running without CDP, save your work first:
# screenstudio launch --restart

# Open a project
screenstudio project open ~/Screen\ Studio\ Projects/MyRecording.screenstudio

# Check connection and capabilities
screenstudio status
screenstudio doctor

# Edit by transcript
screenstudio transcript show
screenstudio transcript cut --text "let me start again"
screenstudio transcript fillers --remove
screenstudio transcript edit          # opens $EDITOR: delete text to cut it from the video

# Check a frame, then export
screenstudio preview --at 5000 --open
screenstudio export --output ~/Movies/final.mp4 --resolution 2160 --fps 60
```

## Commands

### Transcript (edit by transcript)

Every word of the transcript is a **token** with an index. Long pauses (1s or more) are tokens too. `transcript show --words` prints the indexes.

```bash
screenstudio transcript status                      # generator, words, cuts, fillers, pauses
screenstudio transcript show                        # paragraphs with timestamps and token ranges
screenstudio transcript show --cut                  # include words already cut, as [-word-]
screenstudio transcript show --words --from 100 --to 160
screenstudio transcript cut 120-180                 # cut tokens from the video (like ⌫ in the app)
screenstudio transcript cut --text "eso no lo quería decir" --dry-run
screenstudio transcript restore --text "this sentence"   # bring cut words back
screenstudio transcript hide 42-45                  # hide from captions only (like ⌘⌫)
screenstudio transcript unhide 42-45
screenstudio transcript fix 42 "Gemini"             # correct caption text; the video is unchanged
screenstudio transcript fix 120-122 "LabBench 2"
screenstudio transcript fillers                     # list um/uh...
screenstudio transcript fillers --language es --remove   # use the CLI's Spanish filler list
screenstudio transcript pauses --tighten            # shorten long pauses, keeping a breath
screenstudio transcript generate --engine whisper --language es --model medium
screenstudio transcript generate --engine elevenlabs --verbatim --keyterms "Claude,Anthropic"
screenstudio transcript srt captions.srt            # SRT with the video's cuts applied
```

Cuts use the app's own logic: the cut extends from the end of the previous kept word to the start of the next one (keeping a short breath), and zooms, layouts and masks left without footage are removed, exactly as in the app.

**Edit the video as text.** `transcript text` writes the transcript as plain text, one paragraph per block. Delete words, sentences or whole paragraphs and `transcript apply` cuts them from the video. Retyping a word (a typo, merged or split words, punctuation) corrects the captions instead of cutting it. `transcript edit` does both in `$EDITOR` and asks for confirmation.

```bash
screenstudio transcript text -o transcript.txt
# ...edit transcript.txt...
screenstudio transcript apply transcript.txt --dry-run   # review the cuts and corrections
screenstudio transcript apply transcript.txt
screenstudio project undo                                # one step undoes the whole apply
```

Screen Studio detects filler words from the transcript's language, and falls back to English for ElevenLabs transcripts, which carry no language. `--language` makes the CLI find them with its own list (`en`, `es`, `de`, `fr`, `pt`, `it`, `pl`, `nl`). Filler words only appear in verbatim transcripts (`generate --engine elevenlabs --verbatim`).

### Timeline (Slices)

```bash
screenstudio slice list                              # show all slices
screenstudio slice split 15000                       # split at 15s (source ms)
screenstudio slice remove 2                          # remove slice by index
screenstudio slice remove --from 6000 --to 8000      # remove a source time range
screenstudio slice speed 0 2.0                       # set slice 0 to 2x speed
screenstudio slice speed all 2.0                     # apply speed to every slice
screenstudio slice update all --system-volume 0      # mute system audio across slices
screenstudio slice update 0 --volume 1 --device-volume 0.5 --hide-cursor
screenstudio slice merge 1                           # merge slice 1 with next
screenstudio slice trim 0 --start 2000 --end 10000   # adjust boundaries directly
```

### Zooms

```bash
screenstudio zoom list
screenstudio zoom add 5000 --end 9000 --level 2 --x 0.3 --y 0.8
screenstudio zoom add 5000 --end 9000 --loupe --radius 0.4      # Glass Loupe lens
screenstudio zoom add 5000 --type follow-mouse                  # auto zoom (alias: --type auto)
screenstudio zoom update <id> --level 3 --instant
screenstudio zoom update <id> --screen                          # turn a loupe back into a zoom
screenstudio zoom split <id> 7000
screenstudio zoom remove <id>
screenstudio zoom clear
screenstudio zoom set '[{...}, {...}]'                          # replace all, as printed by zoom list --json
```

Zoom types are `manual`, `follow-mouse` and `follow-click-groups`. Zooms, masks and layouts cannot overlap in Screen Studio 4; adding one where another already is fails with an error.

### Masks

```bash
screenstudio mask list
screenstudio mask add 0 10000 --x 100 --y 200 --width 400 --height 50 --blur 20
screenstudio mask add 0 10000 --type highlight --opacity 0.5
screenstudio mask update <id> --x 150 --width 500
screenstudio mask update <id> --disable
screenstudio mask remove <id>
screenstudio mask clear
```

### Camera Layouts

```bash
screenstudio layout list
screenstudio layout add 60000 90000 --type fullscreen-camera
screenstudio layout update <id> --type split-screen
screenstudio layout remove <id>
```

Types: `camera-overlay`, `split-screen`, `fullscreen-camera`, `screen-only`, `cutout-camera`.

### Config

Screen Studio 4 groups the project config: `captions.*`, `audio.*`, `cursor.*`, `camera.*`, `styles.*`, `output.*`...

```bash
screenstudio config --list                       # the whole config
screenstudio config --flat                       # every path and value
screenstudio config captions.enableTranscript true
screenstudio config captions.position01.y 0.9    # nested values are merged
screenstudio config audio.clickSoundEffect       # read a value
```

3.x flat keys fail with a hint: `config clickSoundEffect` → *Did you mean audio.clickSoundEffect?*

### Audio

```bash
screenstudio audio info
screenstudio audio library                          # built-in track names and paths
screenstudio audio add /path/to/music.mp3 --volume 0.1
screenstudio audio remove                           # undoable; keeps the copied asset
```

### Preview & Verification

```bash
screenstudio preview                         # render the current frame (Screen Studio's renderer)
screenstudio preview --at 5000 --height 2160 --open
screenstudio seek 10000                      # move the playhead (playback ms)
screenstudio seek 120000 --source            # ...or a recording (source) time
screenstudio render --fps 10 --from 3000 --to 6000   # approximate zoom crops via ffmpeg
screenstudio analyze --interval 2            # extract frames + event timeline
```

`preview` renders with all effects (zooms, loupe, camera, captions, background). Offline `render` and `analyze` read the raw recording with ffmpeg; `render` only approximates static zoom crops and skips loupe zooms.

### Export

```bash
screenstudio export                                      # current settings; the app asks where to save
screenstudio export --output final.mp4 --resolution 4k --fps 60 --quality studio
screenstudio export --output demo.gif --format gif --resolution 720
screenstudio export --clipboard
screenstudio export --wait                               # wait and show progress
screenstudio export --picker                             # just open the export dialog
```

Options left out come from the settings you last used in the app. `--output` exports without a dialog through the app's clipboard export, so it **also copies the video to the clipboard**. MP4: `--fps` 60, 50, 30, 25, 24, 20, 10; `--resolution` 720, 1080, 2160 (4k); `--quality` studio, social-media, web-high, web-low; `--codec` h264, h265. GIF: `--fps` 50, 30, 25, 20, 15, 10; `--resolution` 480, 720, 1080.

### App Actions

Run anything in Screen Studio's command menu by id:

```bash
screenstudio action list                            # actions that apply right now
screenstudio action list --all --search zoom
screenstudio action run resetTrimsAndCutsForAllSlices
screenstudio action run toggleZoomLoupeMode --zoom <id>   # actions for one zoom, mask, slice or layout
```

### Recording

```bash
screenstudio record displays                                 # list displays with visible apps
screenstudio record windows                                  # list windows with titles
screenstudio record start --app Terminal                     # record display containing app
screenstudio record start --mode window --title "YouTube"    # record specific window by title
screenstudio record pause
screenstudio record resume
screenstudio record stop                                     # stop and save
screenstudio record cancel                                   # stop and discard
```

### Project

```bash
screenstudio project list        # open projects; * marks the focused one
screenstudio project info
screenstudio project open <path>
screenstudio project save        # the app's own save
screenstudio project undo
screenstudio project redo
```

### Raw Execution

```bash
screenstudio exec 'electronEnv.APP_VERSION'
screenstudio exec --runtime 'return ss.project().name'      # with the CLI's helpers
screenstudio exec --runtime --file script.js
```

## Global Flags

All commands support:
- `--json` — structured JSON output (put before the command: `screenstudio --json state`)
- `--port <n>` — CDP port (default 9222)
- `--project <name-or-path>` — the project to act on when several are open (default: the focused one)

`launch` and `project open` take `--app <path>` (or `SCREENSTUDIO_APP`) to drive another Screen Studio build, such as a beta.

## Key Internals

**Finding the app's models**: Screen Studio 4 registers the open projects in `window.$projects` and the focused editor in `window.$$focused`. Everything else is reached through the React tree by duck typing on method names, which survive minification: the action manager (command menu) and the "Edit by transcript" controller. The transcript panel creates its controller when it mounts, so transcript commands open that panel for a moment and then restore the sidebar you had open.

**Main window vs render worker**: Screen Studio 4 loads `index.html` twice, in the main window and in a hidden render worker. The CLI connects to the window that registers `$projects`.

**Timeline collections**: slices, zooms, masks, layouts and voiceovers share one collection API (`add`, `splitAt`, `findAt`, `remove`...). Items cannot overlap; `add` fits a new item into the free range at its start.

**Undo**: edits are buffered for 100ms before they become an undo step, so one command is one step. `project info` and `undo`/`redo` flush the buffer first.

**Speed**: Screen Studio uses `timeScale = 1/speed`. `slice speed` takes the speed you want.

## AI Agent Skill

The `skills/screenstudio-cli/` directory contains a SKILL.md that AI agents (Claude Code, Codex, etc.) can load to learn the CLI, including the transcript text-editing workflow. `skills/screenstudio-cli/references/demo.md` covers recording and editing a terminal + browser demo.

## Development

```bash
npm test  # build and regression checks; optional ffmpeg integration check
```

Tests run against a small contract fixture of the Screen Studio 4 models, not the real app. `screenstudio doctor` checks a live install.

## License

MIT. Originally created by [Shawn Pana](https://github.com/ShawnPana/screenstudio-cli), hardened for 3.7 by [rorz](https://github.com/rorz/screenstudio-cli).
