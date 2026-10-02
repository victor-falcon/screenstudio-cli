---
name: screenstudio-cli
description: Record, edit, inspect, and export Screen Studio 4 projects on macOS using the screenstudio CLI — including editing the video by editing its transcript (cut words, sentences or paragraphs, remove filler words and pauses, fix captions).
---

# screenstudio-cli

Control Screen Studio 4 from the command line via the Chrome DevTools Protocol. No plugins, no extensions — a direct WebSocket connection to the Electron app's MobX models.

## Setup

Screen Studio must be launched with the debug port enabled:

```bash
screenstudio launch              # launch or reuse an existing CDP connection
screenstudio launch --restart    # explicitly quit and relaunch; save work first
screenstudio launch --port 9333  # custom port
```

Then open a project — from Screen Studio's UI or:

```bash
screenstudio project open "/path/to/recording.screenstudio"
```

Verify with `screenstudio status` and `screenstudio doctor` with a project open. The compatibility audit targets **4.0.1-4897** (2026-10-02); see the project's `docs/compatibility.md`. This CLI does not support Screen Studio 3.x. Respect the user's app/service startup preferences; reuse their running connection and port.

With several projects open, commands act on the focused one; pass `--project <name or path>` to choose. Commands that need the editor window (transcript, seek, preview, export, actions, save) fail if it is closed.

## Editing Method: Watch → Edit → Watch

**Before editing, read `references/demo.md`** if the recording has a terminal and browser side by side. It covers the 2x zoom grid system, story-following subagent methodology, and common framing mistakes.

Every edit follows the same loop: **look at the section first, make the change, then look again to confirm it worked.** Don't edit blind.

1. **Watch** — For speech, read the transcript (`screenstudio transcript show`). For visuals, render frames: `screenstudio preview --at <ms>` renders one frame with every effect; `screenstudio render --from <start> --to <end> --fps 10` extracts many frames with approximate zoom crops.
2. **Edit** — Make the mutation (transcript cut, slice, zoom, mask, config...).
3. **Watch again** — Re-read the transcript around the cut (`transcript show --cut`) or re-render the frames, and compare. If something is off, `screenstudio project undo` and try again.

You cannot see the video — only the transcript and extracted frames. **Use subagents for frame analysis**: rendered frames can number in the hundreds. Give a subagent specific questions ("Is the terminal fully in frame?", "At which frame does the page change?") and keep your main context for decisions.

## Edit by Transcript

The most direct way to edit a talking-head or narrated recording. Every transcript word is a **token** with an index; long pauses (≥1s) are `gap` tokens. Cuts use Screen Studio's own logic: a cut spans from the end of the previous kept word to the start of the next (keeping a short breath), and zooms/layouts/masks left without footage are removed.

```bash
screenstudio transcript status                 # is there a transcript? generator, cuts, fillers, pauses
screenstudio transcript show                   # paragraphs: "¶3  01:03.1  #202-250" + text
screenstudio transcript show --cut             # also show words already cut, as [-word-]
screenstudio transcript show --words --from 200 --to 260   # token indexes, times and state
screenstudio --json transcript show            # every token: index, kind, text, times, present, hidden, filler
```

Cut, restore, hide and fix by token range or by phrase:

```bash
screenstudio transcript cut 202-250                         # cut tokens from the video
screenstudio transcript cut --text "vale, empiezo otra vez" --dry-run
screenstudio transcript cut --text "o sea" --all            # every occurrence
screenstudio transcript cut --text "bueno" --occurrence 2   # only the 2nd one
screenstudio transcript restore --text "this sentence"     # bring cut words back
screenstudio transcript hide 42-45                          # hide from captions only; video unchanged
screenstudio transcript unhide 42-45
screenstudio transcript fix 42 "Gemini"                     # correct caption text; video unchanged
screenstudio transcript fix 120-122 "LabBench 2"
```

Fillers, pauses, generation, captions:

```bash
screenstudio transcript fillers                       # Screen Studio's filler detection
screenstudio transcript fillers --language es         # the CLI's list for Spanish (en, es, de, fr, pt, it, pl, nl)
screenstudio transcript fillers --language es --remove
screenstudio transcript pauses                        # long pauses that can be tightened
screenstudio transcript pauses --tighten
screenstudio transcript generate --engine whisper --language es --model medium
screenstudio transcript generate --engine elevenlabs --verbatim --keyterms "Claude,Anthropic"
screenstudio transcript srt /tmp/captions.srt         # SRT with cuts applied
```

- Screen Studio detects fillers from the transcript's language and falls back to **English** for ElevenLabs transcripts. For other languages use `--language`.
- Fillers only exist in **verbatim** transcripts (`--engine elevenlabs --verbatim`). Non-verbatim transcripts omit "um"/"eh".
- `generate` replaces the transcript and its text corrections. ElevenLabs uploads the audio to the cloud. Ask the user before generating.

### Workflow: edit the video as a text file

This is the best workflow for agents: read the whole transcript, decide what to remove, and apply all cuts at once.

```bash
screenstudio transcript text -o /tmp/transcript.txt
```

The file has a header comment, then one block per paragraph with a `# ¶N mm:ss.s` comment line. Edit it with your file-editing tools:

- **Delete** words, sentences or whole paragraphs to cut them from the video.
- **Retype** a word to correct the captions (typos, names, merged/split words, punctuation). Text typed in place of deleted words replaces the deleted words it resembles; if it resembles none, the whole stretch is a caption rewrite and nothing is cut.
- Don't add new sentences: the audio cannot say them. Lines starting with `#` are ignored.

Then review and apply:

```bash
screenstudio transcript apply /tmp/transcript.txt --dry-run   # lists "cut ..." and "fix ..." lines
screenstudio transcript apply /tmp/transcript.txt
screenstudio transcript show --cut                            # verify
screenstudio project undo                                     # one step undoes the whole apply
```

Always run `--dry-run` first and check that every `cut` line is something the user wants gone. Use `--cuts-only` to ignore text corrections. If the transcript changed after you exported it (edits in the app), re-export: indexes are checked and stale edits are refused.

## Core Workflow

### 1. Read State

```bash
screenstudio state --json      # project, grouped config, slices, zooms, masks, layouts, recording
screenstudio state             # human-readable summary
screenstudio state --slices    # timeline segments with timing and speed
screenstudio state --zooms     # zooms with type, presentation and source range
screenstudio state --masks
screenstudio state --layouts   # camera layouts
screenstudio state --config
screenstudio state --recording # recording metadata, sessions, keystroke/mouse event counts
```

### 2. Mutate

#### Timeline Slices

Slices are segments of the recording timeline. Each has a source time range, speed, and audio volumes.

```bash
screenstudio slice list
screenstudio slice split 15000                       # split at 15s (source time in ms)
screenstudio slice remove 2                          # remove slice by index
screenstudio slice remove --from 6000 --to 8000      # remove a source time range
screenstudio slice speed 0 2.0                       # set slice 0 to 2x speed
screenstudio slice speed all 2
screenstudio slice update all --system-volume 0 --device-volume 0.5
screenstudio slice update 0 --volume 1 --hide-cursor --raw-cursor
screenstudio slice merge 1                           # merge slice 1 with next
screenstudio slice trim 0 --start 2000 --end 10000
```

Prefer transcript cuts for speech: they place the cut between words. Use `slice remove --from --to` for silent sections or exact times.

#### Zooms

Each zoom has an ID, a source time range, a level, a type (`manual`, `follow-mouse`, `follow-click-groups`) and a presentation (`screen` zooms the frame; `loupe` is a Glass Loupe lens over the screen).

```bash
screenstudio zoom list
screenstudio zoom add 5000 --end 9000 --level 2 --x 0.3 --y 0.8      # manual zoom on a point
screenstudio zoom add 5000 --end 9000 --type follow-mouse           # auto zoom (alias: auto)
screenstudio zoom add 5000 --end 9000 --loupe --radius 0.4 --level 2.5
screenstudio zoom update <id> --x 0.45 --y 0.82          # move the target (keeps the other axis)
screenstudio zoom update <id> --start 0 --end 50000
screenstudio zoom update <id> --disable / --enable
screenstudio zoom update <id> --instant / --animated
screenstudio zoom update <id> --screen                   # loupe → regular zoom
screenstudio zoom split <id> 25000
screenstudio zoom remove <id>
screenstudio zoom clear
screenstudio zoom set '[{...}, {...}]'                   # replace all, shape of zoom list --json
```

Zooms cannot overlap. `zoom add` fails if another zoom covers its start, and shortens it to end where the next zoom starts.

**Coordinate system:** `manualTargetPoint` is normalized (0-1) relative to the full recording frame. x=0 is the left edge, x=1 the right edge, y=0 the top, y=1 the bottom.

#### Masks

```bash
screenstudio mask list
screenstudio mask add 0 10000 --x 100 --y 200 --width 400 --height 50 --blur 20
screenstudio mask add 0 10000 --type highlight --opacity 0.5
screenstudio mask update <id> --x 150 --width 500      # keeps the other bounds
screenstudio mask update <id> --start 0 --end 15000 --blur 30
screenstudio mask update <id> --disable
screenstudio mask remove <id>
screenstudio mask clear
```

Mask `bounds` use recording pixels. Masks cannot overlap in time.

#### Camera Layouts

```bash
screenstudio layout list
screenstudio layout add 60000 90000 --type fullscreen-camera
screenstudio layout update <id> --type split-screen
screenstudio layout remove <id>
```

Types: `camera-overlay`, `split-screen`, `fullscreen-camera`, `screen-only`, `cutout-camera`. Outside layout ranges the project's default layout applies (`config defaultLayout.type`).

#### Config

Screen Studio 4 groups the config: `crop`, `cursor`, `captions`, `audio`, `camera`, `animations`, `processing`, `zooms`, `defaultLayout`, `styles`, `device`, `output`. Address keys by path:

```bash
screenstudio config --flat                            # every path and value
screenstudio config captions.enableTranscript true    # show captions
screenstudio config captions.position01.y 0.9         # nested values are merged
screenstudio config audio.clickSoundEffect            # read
screenstudio config cursor.size 2
```

Values are parsed as JSON (numbers, booleans, null, objects), else kept as strings. Unknown paths fail; 3.x flat keys fail with the new path as a hint.

#### Audio

```bash
screenstudio audio info                               # config.audio
screenstudio audio library
screenstudio audio add /path/to/music.mp3 --volume 0.1
screenstudio audio remove                             # keeps the asset for undo
```

#### App Actions

Anything in Screen Studio's command menu can run by id:

```bash
screenstudio action list                              # actions that apply now
screenstudio action list --all --search slice
screenstudio action run resetTrimsAndCutsForAllSlices
screenstudio action run toggleZoomLoupeMode --zoom <id or index>
```

Some actions show a confirmation dialog in the app.

#### Project

```bash
screenstudio project list
screenstudio project info        # name, path, durations, counts, dirty, undo/redo
screenstudio project save        # the app's own save
screenstudio project undo        # each CLI command is one undo step
screenstudio project redo
```

### 3. Verify

```bash
screenstudio preview                         # current frame → /tmp/screenstudio-preview.png
screenstudio preview --at 5000 -o ./check.png --height 1080
screenstudio preview --at 120000 --source    # a recording (source) time
screenstudio seek 10000                      # playback ms, or start / end
```

`preview` renders with Screen Studio's own renderer: zooms, loupe, camera, captions and background included.

```bash
screenstudio render --fps 15 --from 3000 --to 6000 -o ./frames/   # source ms, approximate zoom crop
screenstudio analyze --interval 2 --from 5000 --to 15000          # frames + keystroke/mouse timeline
```

`render`/`analyze` use ffmpeg on the raw recording and need a single recording session. `render` applies a static crop per zoom (`videoWidth/Z × videoHeight/Z` centered on the target), skips loupe zooms, and does not follow the cursor.

### 4. Export

```bash
screenstudio export --output /tmp/final.mp4 --resolution 2160 --fps 60 --quality studio
screenstudio export --output /tmp/demo.gif --format gif --resolution 720
screenstudio export                     # the app asks where to save
screenstudio export --wait              # ...and wait for it
screenstudio export --clipboard
screenstudio export --picker            # only open the export dialog
```

Options left out come from the user's last export settings. `--output` saves without a dialog through the app's clipboard export, so it also **replaces the user's clipboard** — tell the user. MP4 `--fps`: 60, 50, 30, 25, 24, 20, 10; `--resolution`: 720, 1080, 2160 (4k); `--quality`: studio, social-media, web-high, web-low; `--codec`: h264, h265. GIF `--fps`: 50, 30, 25, 20, 15, 10; `--resolution`: 480, 720, 1080.

### 5. Recording

```bash
screenstudio record windows                                  # list windows with titles
screenstudio record displays                                 # list displays with visible apps
screenstudio record start                                    # record the default display
screenstudio record start --app Terminal                     # display containing an app
screenstudio record start --mode window --title "YouTube"    # window matching a title
screenstudio record start --mode area
screenstudio record pause / resume
screenstudio record stop                                     # stop and save
screenstudio record cancel                                   # stop and discard
```

`record start` opens Screen Studio's picker overlay, finds the target, and clicks record. Recording has not been verified live against Screen Studio 4.

### 6. Raw Execution

```bash
screenstudio exec 'electronEnv.APP_VERSION'
screenstudio exec --runtime 'var p = ss.project(); return { name: p.name, slices: p.scene.slices.length }'
screenstudio exec --runtime --file script.js
```

With `--runtime` the script is an async function body that returns JSON, with these helpers:

- `ss.project()` — the selected project; `ss.projects()` — all open projects
- `ss.editor(p)` — the project's editor (`playback`, `view`, `animation`, `exportManager`)
- `ss.transcriptEditor(editor)` — the "Edit by transcript" controller (`tokens`, `paragraphs`, `deleteTokens`, `restoreTarget`, `setCoveredWordsHidden`, `applyWordRangeReplacement`...)
- `ss.runAction(id, target, input)` — run a command-menu action
- `ss.flush(p)` — turn pending edits into an undo step

Model notes: `p.scene.slices|zooms|masks|layouts|voiceOvers` are collections (`all`, `at`, `get`, `add`, `splitAt`, `findAt`, `remove`, `removeAll`); items have `update({...})`, `remove()`, `serialize()`. Config: read `p.projectConfig.serialize()` (not `p.config`, which has circular references), write `p.updateConfig({ captions: { ... } })`. Speed: `timeScale = 1/speed`.

## Important Notes

### Crash Prevention

- **Never set properties to null** that should have values (speed, volume, zoom, type).
- **Do one operation, verify, then continue.** Every command is one undo step; `project undo` is cheap.
- **The app auto-saves edits to disk.** If you corrupt state it persists; you may need to edit `project.json` inside the `.screenstudio` bundle.

### Coordinate Spaces

- **Zoom `manualTargetPoint`** is normalized (0-1) to the full recording frame.
- **Mask `bounds`** use recording pixels, which can differ from the video file's pixel size (Retina scaling). Check `state --recording` and an existing mask's bounds before placing one.
- If the recording has letterbox bars, the content area is a subset of the frame: account for the bars when positioning.

### Timeline vs Source Time

- **Source time**: position in the original recording (ms). Slices, zooms, masks and layouts use source time.
- **Playback time**: position in the edited video (after cuts and speed changes). `seek`, `preview --at` and transcript times use playback time; `seek --source` and `preview --source` take source time.

### Global Flags

- `--json` — structured JSON output (before the command: `screenstudio --json status`)
- `--port <n>` — CDP port (default 9222)
- `--project <name-or-path>` — project to act on when several are open

## References

- **[references/demo.md](references/demo.md)** — **Read this BEFORE editing any recording with a terminal and browser.** Covers the 2x zoom grid system (x=0/1 for left/right, y=0/0.5/1 for top/middle/bottom), how to spawn a story-following subagent for frame analysis, display detection with `--app`, speed changes, and common framing mistakes.
