# screenstudio-cli

Control [Screen Studio](https://www.screen.studio/) from the command line. No plugins, no extensions — direct WebSocket connection to the Electron app's MobX state via Chrome DevTools Protocol.

Record, edit, and inspect Screen Studio projects from the terminal, and trigger the app's export flow. Built for scripted workflows and AI agents (Claude Code, Codex, etc.).

## How It Works

Screen Studio is an Electron app. Launching it with `--remote-debugging-port=9222` exposes Chrome DevTools Protocol, giving direct access to its React/MobX internals. This CLI connects via WebSocket and can:

- Read full project state (slices, zooms, config, recording metadata)
- Mutate the timeline (split, trim, remove, speed up, merge)
- Control zoom ranges (add, remove, split, update position/level)
- Manage sensitive-data and highlight masks
- Set independent audio channels and background music
- Start/stop/pause recordings programmatically
- Seek, preview, and render frames for verification
- Open the export dialog or trigger quick clipboard export

Project edits use Screen Studio's undo-enabled model methods. Recording, export, file operations, and arbitrary `exec` scripts are not covered by project undo.

## Requirements

- **Node.js** >= 22 ([WebSocket is enabled by default](https://nodejs.org/api/globals.html#class-websocket))
- **Screen Studio** (macOS)
- **ffmpeg** (for `render` and `analyze` commands) — `brew install ffmpeg`

## Compatibility

Audited against **Screen Studio 3.7.5-4595** (latest stable on 2026-09-16). Editing, save/reopen, preview, and native MP4 export were verified live with a disposable project. Run `screenstudio doctor` with a project open to inspect runtime capabilities. See [feature coverage and validation details](docs/compatibility.md) for the checks performed and remaining limits, including active recording, device inputs, and beta features.

## Install

```bash
npm install -g screenstudio-cli
```

Or from source:

```bash
git clone https://github.com/ShawnPana/screenstudio-cli.git
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
open ~/Screen\ Studio\ Projects/MyRecording.screenstudio

# Check connection
screenstudio status
# → Connected to Screen Studio 3.7.5-4595 | Project: MyRecording | Duration: 29.3s | 5 slices

# Inspect runtime compatibility
screenstudio doctor

# Read project state
screenstudio state
screenstudio state --json    # full structured dump

# Edit the timeline
screenstudio slice list
screenstudio slice split 15000           # split at 15s
screenstudio slice speed 0 2             # 2x speed on slice 0
screenstudio slice remove --from 6000 --to 8000   # cut a section

# Add a zoom
screenstudio zoom add 0 --end 30000 --level 2 --x 0.5 --y 0.5 --id my_zoom

# Preview
screenstudio preview --at 5000 -o /tmp/check.png --open

# Export
screenstudio export
```

## Commands

### Recording

```bash
screenstudio record displays                                 # list displays with visible apps
screenstudio record windows                                  # list windows with titles
screenstudio record start --app Terminal                      # record display containing app
screenstudio record start --mode window --title "YouTube"     # record specific window by title
screenstudio record pause                                    # pause recording
screenstudio record resume                                   # resume
screenstudio record stop                                     # stop and save
screenstudio record cancel                                   # stop and discard
```

`record displays` shows what apps are on each display, so you always record the right one. `--app` auto-detects which display contains the target app. Window mode uses AppleScript to match by window title.

### Timeline (Slices)

```bash
screenstudio slice list                              # show all slices
screenstudio slice split 15000                       # split at 15s (source ms)
screenstudio slice remove 2                          # remove slice by index
screenstudio slice remove --from 6000 --to 8000      # remove a time range
screenstudio slice speed 0 2.0                       # set slice 0 to 2x speed
screenstudio slice speed all 2.0                     # apply speed to every slice
screenstudio slice update all --system-volume 0     # mute system audio across slices
screenstudio slice update 0 --volume 1 --device-volume 0.5 --hide-cursor
screenstudio slice merge 1                           # merge slice 1 with next
screenstudio slice trim 0 --start 2000 --end 10000   # adjust boundaries directly
```

### Zooms

```bash
screenstudio zoom list                                       # show all zoom ranges
screenstudio zoom add 0 --level 2 --end 50000 --id my_zoom  # add with custom ID
screenstudio zoom add 0 --level 2 --x 0.3 --y 0.8           # with target point
screenstudio zoom remove <id>                                # remove by ID
screenstudio zoom update <id> --level 3 --x 0.5 --y 0.5     # update properties
screenstudio zoom update <id> --instant                     # instant zoom transition
screenstudio zoom update <id> --animated --type auto       # smooth automatic zoom
screenstudio zoom split <id> 25000                           # split at timestamp
screenstudio zoom set '[{...}, {...}]'                       # replace all at once
```

Zoom operations use `scene.update({ zoomRanges })` internally, which is reliable — unlike Screen Studio's built-in `addZoomRangeAt()` which can overwrite adjacent ranges.

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

### Audio

```bash
screenstudio audio info
screenstudio audio library                          # built-in track names and paths
screenstudio audio add /path/to/music.mp3 --volume 0.1
screenstudio audio remove                           # undoable; keeps the copied asset
screenstudio config improveMicrophoneAudio true
screenstudio config microphoneInStereoMode true
screenstudio config muteExternalDeviceAudio true
```

### Config

```bash
screenstudio config --list                            # all keys exposed by your installed version
screenstudio config backgroundColor                   # read a value
screenstudio config backgroundColor "#FF0000"          # write (updates UI immediately)
```

### Preview & Verification

```bash
screenstudio preview                         # screenshot the preview canvas
screenstudio preview --at 5000 --open        # seek to 5s, capture, open in Preview.app
screenstudio seek 10000                      # move playhead
screenstudio render --fps 10 --from 3000 --to 6000   # render zoomed frames via ffmpeg
screenstudio analyze --interval 2            # extract frames + event timeline
```

Offline `render` and `analyze` require one recording session. Use native `preview` for paused/resumed recordings with multiple sessions. `render` approximates static zoom crops; it does not reproduce native effects or automatic cursor following.

For native `preview`, keep one project window open and close recording pickers. Ambiguous auxiliary windows produce an error instead of a screenshot from the wrong window.

### Project

```bash
screenstudio project info        # name, duration, dirty state
screenstudio project save
screenstudio project undo        # undo last CLI mutation
screenstudio project redo
```

### Export

```bash
screenstudio export                  # opens export dialog (Cmd+Shift+E)
screenstudio export --clipboard      # quick export to clipboard
```

### Raw Execution

```bash
screenstudio exec '$project.name'
screenstudio exec --file script.js
echo '$projects.size' | screenstudio exec -
```

## Global Flags

All commands support:
- `--json` — structured JSON output (put before the command: `screenstudio --json state`)
- `--port <n>` — CDP port (default 9222)

## Key Internals

**`$project` vs `$projects`**: The CLI uses `window.$project` (the active/focused project), not `Array.from($projects.values())[0]`. This ensures the correct project is targeted when multiple are open.

**Undo support**: Model methods such as `updateConfig`, `scene.update`, and `updateMask` record edits in the app's history. Undo/redo flush pending history and use the history object's availability checks.

**Speed**: Screen Studio uses `timeScale` internally where `timeScale = 1/speed`. So 4x speed = `timeScale: 0.25`. The `slice speed` command handles this conversion — just pass the speed you want.

**Zoom operations**: All zoom add/remove/split/update operations serialize the full zoom array and call `scene.update({ zoomRanges })`. This avoids `addZoomRangeAt()` which can overwrite adjacent ranges and cause ID collisions.

**Video files**: Offline frame extraction uses `recording.sessions[0].recordingVideoPath` from Screen Studio, so it can locate display, window, device, and imported videos without guessing filenames.

## AI Agent Skill

The `skills/screenstudio-cli/` directory contains a SKILL.md that AI agents (Claude Code, Codex, etc.) can load to learn how to use the CLI. It includes:

- Full command reference
- The "Watch → Edit → Watch" methodology
- Coordinate system documentation
- Crash prevention rules

The `skills/screenstudio-cli/references/demo.md` guide covers end-to-end demo recording and editing with a terminal + browser side-by-side layout, including the 2x zoom grid system for framing content.

## Development

```bash
npm test  # build and regression checks; optional ffmpeg integration check
```

## License

MIT
