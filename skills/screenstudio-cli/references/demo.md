# Recording & Editing Terminal + Browser Demos

End-to-end guide for recording a demo where a terminal (Claude Code) and Chrome browser are side by side on the same display, then editing the recording with zooms, cuts, and speed changes.

## Layout

The typical setup is two windows filling one display:
- **Chrome** on the LEFT half (~x=0 to 0.5 in normalized coords)
- **Terminal** on the RIGHT half (~x=0.5 to 1.0)

## Step 1: Find the Right Display

Use `screenstudio record displays` to see which display has your terminal and browser. It lists the apps visible on each display:

```bash
screenstudio record displays
#   0: PA27JCV (2) — 2560x1440
#        Google Chrome (1280x1410)
#        Terminal (1282x1410)
#   1: PA27JCV (1) — 2560x1440
#        Finder (920x436)
#   2: Built-in Retina Display — 1512x982
#        Spotify (960x949)
```

Or use `--app` to auto-detect:

```bash
screenstudio record start --app Terminal
```

This uses the window picker internally to identify which display page contains the target app, avoiding coordinate mismatches between NSScreen and the picker overlay order.

## Step 2: Record

```bash
screenstudio record start --app Terminal    # or --display <index>
```

Do your demo — type commands, narrate with text output, run browser-use, etc.

```bash
screenstudio record stop                    # saves and dismisses picker overlay
```

## Step 3: Open the Project

```bash
# Find the latest project
ls -lt ~/Screen\ Studio\ Projects/ | head -3

# Open it
screenstudio project open "/path/to/project.screenstudio"

# Verify
screenstudio status
```

If multiple projects are open, commands act on the focused one. Pass `--project <name or path>` to choose another, or close the old project.

## Step 4: Analyze the Recording

Use a subagent to extract and review frames:

```bash
screenstudio analyze --interval 1.5 -o /tmp/demo-frames/
```

Or for more precise analysis, extract with ffmpeg:

```bash
ffmpeg -i "<recording>/channel-*-display-*.mp4" -vf "fps=1/1.5,scale=960:-1" -q:v 2 /tmp/frames/frame_%03d.jpg -y
```

Have the subagent read ALL frames and **follow the story**. The subagent should act like a viewer watching the video — tracking the narrative, understanding what content the viewer should be looking at, and flagging when the zoom is showing the wrong thing. The prompt should instruct the subagent to:

1. **Track the narrative arc**: What step of the demo are we in? What just happened? What should the viewer be reading?
2. **Identify what content the viewer SHOULD see** at each frame — the newest text, the key result, the heading that just appeared.
3. **Check if the zoom is showing that content** or if it's showing old output, the wrong side, or has the important text at the edge/cut off.
4. **Flag dead periods** where nothing changes for multiple frames.
5. **Suggest specific fixes** using the grid system (x=0/1, y=0/0.5/1) for each problem found.

This is critical — a simple "what's on screen" analysis misses framing issues. The subagent needs to understand the STORY to know whether the camera is pointed at the right place. For example, when a heading like "Here are your latest notifications:" appears at the bottom of the terminal, the subagent should flag that y=0.5 is wrong because the new content is at the bottom (y=1).

Common issues the subagent should catch:
- **Setup scaffolding visible**: Recording commands (`screenstudio record start/cancel`) visible in the intro. Fix: y=1 to push them above the crop.
- **New text at bottom, zoom at middle**: Terminal scrolls down but zoom is still at y=0.5, so the newest text is at the edge or off-screen. Fix: y=1.
- **Browser loading state**: Page is loading but zoom shows sidebar icons instead of the content area. Fix: y=0 to show the header/URL loading.
- **Long stalls**: 5+ frames with no change. Speed up or cut.
- **Zoom-out flash**: A gap between zoom ranges causes a momentary zoom-out to the full view. Fix: make zoom ranges adjacent (no gaps).

## Step 5: Cut Dead Time

Cut the beginning if it has setup/meta content:

```bash
screenstudio slice trim 0 --start 4500     # skip first 4.5s of setup
```

Cut the end if it shows the recording stop command:

```bash
screenstudio slice trim 0 --end 41000      # cut the last few seconds
```

Remove time ranges:

```bash
screenstudio slice remove --from 6000 --to 8000
```

## Step 6: Speed Up Idle Periods

Split at idle boundaries and set 2x speed:

```bash
screenstudio slice split 22500
screenstudio slice split 25500
screenstudio slice speed 1 2               # speed up the middle slice (index 1)
```

Typical idle periods in a terminal demo:
- Waiting for commands to execute (loading spinners, "thinking" indicators)
- Between a command finishing and the next narration text appearing
- Browser page loading

## Step 7: Editing — Zooms and Framing

The key principle: **zoom to wherever the action is happening.** When text appears in the terminal, zoom to terminal. When the browser loads something visual, zoom to browser. Every time something new happens on screen, the camera should move to frame it.

### Zoom Level

**Always use 2x zoom (200%).** This crops to exactly half the frame, which for a side-by-side layout means you're showing one full side of the screen. At 2x on a 4096x2304 video, the visible area is 2048x1152 — roughly one window.

```bash
screenstudio zoom add <start> --end <end> --level 2 --x <x> --y <y>
```

Screen Studio assigns zoom IDs. `screenstudio --json zoom add ...` prints the new zoom, including its `id`, for later `zoom update`/`remove` calls.

### The Grid System

Think of the screen as a 2x3 grid. The **x position** picks left or right (which window), and the **y position** picks top, middle, or bottom (where the content is within that window). At 2x zoom, Screen Studio clamps the crop to the video bounds, so extreme values (0 and 1) push the crop to the edge.

```
┌─────────────────┬─────────────────┐
│  LEFT-TOP       │  RIGHT-TOP      │
│  (0, 0)         │  (1, 0)         │
├─────────────────┼─────────────────┤
│  LEFT-MIDDLE    │  RIGHT-MIDDLE   │
│  (0, 0.5)       │  (1, 0.5)       │
├─────────────────┼─────────────────┤
│  LEFT-BOTTOM    │  RIGHT-BOTTOM   │
│  (0, 1)         │  (1, 1)         │
└─────────────────┴─────────────────┘
```

**X positions:**
- `x=0` — Left side (Chrome/browser). Shows the full left half.
- `x=1` — Right side (Terminal). Shows the full right half.

**Y positions:**
- `y=0` — Top. Shows the top half of the screen (browser tabs/address bar, terminal top).
- `y=0.5` — Middle. Shows the vertically centered content.
- `y=1` — Bottom. Shows the bottom half (bottom of page, terminal's latest output).

### Choosing the Right Grid Cell

**For the terminal (right side, x=1):**
- **Right-Bottom** `(1, 1)` — **Most common.** Terminal output scrolls upward, so the newest text is always at the bottom. Use this when new command output, narration text, or headings are appearing. This hides old output that's scrolled above.
- **Right-Middle** `(1, 0.5)` — Use when a block of output has finished printing and sits in the middle of the terminal. Good for completed summaries or multi-line results.
- **Right-Top** `(1, 0)` — Rare. Only when you want to show the terminal title bar or content at the very top.

**For the browser (left side, x=0):**
- **Left-Middle** `(0, 0.5)` — **Most common.** The main content area of a webpage (article text, notification feed, search results).
- **Left-Top** `(0, 0)` — When focusing on the address bar, page header, or showing the URL changing. Also good during page loading to show the page title/header appearing.
- **Left-Bottom** `(0, 1)` — When content is at the bottom of the visible page, e.g., a form, footer, or cookie banner.

### When to Switch Zoom Position

Create a new zoom every time the viewer's attention should move:

1. **New step/heading appears in terminal** → Right-Lower (that's where it prints)
2. **Command runs and output appears** → Right-Lower or Right-Middle depending on output length
3. **Browser navigates to a new page** → Left-Upper briefly (URL change), then Left-Middle (content loads)
4. **Dialog/popup appears in browser** → Left-Middle (centered dialogs) or wherever the dialog is
5. **Browser content scrolls** → Follow the content vertically
6. **Summary/conclusion text in terminal** → Right-Middle or Right-Lower

### Example: Terminal + Browser Demo

```bash
# Intro text streaming in terminal — bottom, where new text appears
screenstudio zoom add 4500 --end 9000 --level 2 --x 1 --y 1

# Chrome shows a permission dialog — middle of browser
screenstudio zoom add 9000 --end 10500 --level 2 --x 0 --y 0.5

# Terminal shows connection result — bottom
screenstudio zoom add 10500 --end 15000 --level 2 --x 1 --y 1

# Step 2 heading + tab list — terminal bottom
screenstudio zoom add 15000 --end 19500 --level 2 --x 1 --y 1

# X.com loading — browser top (show header/URL loading)
screenstudio zoom add 19500 --end 21000 --level 2 --x 0 --y 0

# X.com notifications visible — browser middle (show the feed)
screenstudio zoom add 21000 --end 25500 --level 2 --x 0 --y 0.5

# Step 3 + state processing — terminal bottom
screenstudio zoom add 25500 --end 31500 --level 2 --x 1 --y 1

# Eval extraction — terminal bottom (result appearing at bottom)
screenstudio zoom add 31500 --end 34500 --level 2 --x 1 --y 1

# Notification summary list — terminal bottom (list growing downward)
screenstudio zoom add 34500 --end 39000 --level 2 --x 1 --y 1

# Outro text — terminal bottom
screenstudio zoom add 39000 --end 41000 --level 2 --x 1 --y 1
```

### Zoom Transitions

Screen Studio animates between zoom positions with a glide effect. When zooms alternate between left and right sides, this creates a natural "camera pan" across the screen. The project's `animations.screenMovementSpring` setting (`screenstudio config animations.screenMovementSpring`) controls how the camera moves; `--instant` on a zoom skips the animation.

**Adjacent zooms** (end of one = start of next) create smooth continuous camera movement. This is ideal for the alternating terminal/browser pattern.

**Gaps between zooms** (no active zoom) snap back to the full unzoomed view. This can work as a "breathing" moment showing both sides, or it can feel jarring. For a polished demo, keep zooms adjacent or leave intentional 1-2 second gaps at natural pause points.

### Deciding What to Zoom

Watch the video frame by frame (use a subagent with frames every 1-1.5 seconds). For each moment, ask:

1. **Where is new content appearing?** Zoom there.
2. **Is the viewer supposed to read something?** Zoom close enough that text is readable.
3. **Is nothing changing?** Either speed up this section or leave the zoom where it was.
4. **Did the action switch sides?** Pan to the other side.

The worst thing is having the zoom on the wrong side — the terminal shows important output but the camera is pointed at the browser showing nothing new (or vice versa). Every zoom should be justified by something happening in that area at that time.

## Step 8: Verify

Use `screenstudio preview` to check key moments:

```bash
screenstudio preview --at 1000 -o /tmp/check-intro.png
screenstudio preview --at 14000 -o /tmp/check-browser.png
screenstudio preview --at 25000 -o /tmp/check-summary.png
```

Known limitation: preview seek may not advance properly when the project has speed changes. If previews show the same frame, try playing the video in Screen Studio's UI instead.

For thorough verification, use a subagent to render frames with zoom crops applied via `screenstudio render` and review them.

## Step 9: Save and Export

```bash
screenstudio project save
screenstudio export               # opens export dialog
screenstudio export --clipboard   # quick export to clipboard
```

## Common Issues

### Wrong display recorded
`--app Terminal` uses the window picker to identify displays, which is reliable. Don't use `--display <index>` unless you've confirmed the index with `record displays` — the picker overlay order doesn't always match NSScreen order for same-resolution monitors.

### Preview not updating after seek
The seek/preview commands can be unreliable when speed changes are applied. Play the video in Screen Studio's UI to verify, or use `screenstudio render` with ffmpeg to check specific frames.

### Picker overlays stuck on screen
After `record stop` or `record cancel`, Screen Studio's picker overlays sometimes reappear. The CLI auto-dismisses them by clicking the `RecordingPicker__UICloseButton` in the overlay pages. If they get stuck, press Escape manually.

### Text clipped at zoom edges
At 2x zoom, the crop covers exactly 50% of the frame — one full side of a side-by-side layout. With x=0 or x=1, Screen Studio clamps to the edge so nothing is clipped horizontally. If text is cut off vertically:
- Content at the top is cut off → lower y (toward 0)
- Content at the bottom is cut off → raise y (toward 1)
- Most terminal demos should use y=1 since new text always appears at the bottom

### Speed changes via CLI
`screenstudio slice speed <index> <multiplier>` uses `timeScale = 1/speed` internally. The CLI handles the conversion — just pass the speed you want (e.g., `2` for 2x).

## Example Timeline

A 30-second demo of "using browser-use to check X notifications":

| Source | Speed | Content | Position | Grid Cell |
|--------|-------|---------|----------|-----------|
| 4.5-9s | 1x | Intro text + Step 1 heading | (1, 1) | Right-Bottom |
| 9-10.5s | 2x | Chrome debug dialog | (0, 0.5) | Left-Middle |
| 10.5-15s | 2x/4x | Connect result + idle | (1, 1) | Right-Bottom |
| 15-19.5s | 1x/4x | Step 2 + tab list + navigate | (1, 1) | Right-Bottom |
| 19.5-21s | 1x | X.com loading | (0, 0) | Left-Top |
| 21-25.5s | 1x/4x | X notifications visible | (0, 0.5) | Left-Middle |
| 25.5-31.5s | 1x/4x | Step 3 + state processing | (1, 1) | Right-Bottom |
| 31.5-34.5s | 1x/4x | Eval extraction | (1, 1) | Right-Bottom |
| 34.5-39s | 1x | Notification summary | (1, 1) | Right-Bottom |
| 39-41s | 1x | "And that's it!" outro | (1, 1) | Right-Bottom |
