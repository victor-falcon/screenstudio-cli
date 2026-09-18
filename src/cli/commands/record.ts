import { Command } from "commander";
import { execSync } from "child_process";
import { withClient } from "../../cdp/client.js";
import { output, table } from "../format.js";

// Find the record function from the React fiber tree and cache it
const CACHE_RECORD_FNS = `
  if (!window.__recordFns) {
    var root = document.getElementById("root");
    var fiberKey = Object.keys(root).find(function(k) { return k.startsWith("__reactContainer"); });
    var fiber = root[fiberKey];
    var queue = [fiber];
    var visited = 0;
    var fns = {};
    while (queue.length > 0 && visited < 3000) {
      var node = queue.shift();
      visited++;
      if (!node) continue;
      if (node.memoizedProps && node.memoizedProps.label && node.memoizedProps.onClick) {
        var label = node.memoizedProps.label;
        if (label === "Record display") fns.display = node.memoizedProps.onClick;
        else if (label === "Record window") fns.window = node.memoizedProps.onClick;
        else if (label === "Record area") fns.area = node.memoizedProps.onClick;
      }
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
    }
    window.__recordFns = fns;
  }
`;

interface WindowInfo {
  app: string;
  title: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

function getWindowList(): WindowInfo[] {
  try {
    const script = `
      set output to ""
      tell application "System Events"
        repeat with proc in (every process whose visible is true)
          try
            set procName to name of proc
            repeat with w in (every window of proc)
              try
                set wName to name of w
                set wSize to size of w
                set wPos to position of w
                set output to output & procName & "|||" & wName & "|||" & (item 1 of wSize) & "|||" & (item 2 of wSize) & "|||" & (item 1 of wPos) & "|||" & (item 2 of wPos) & "\\n"
              end try
            end repeat
          end try
        end repeat
      end tell
      return output
    `;
    const raw = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    return raw
      .split("\n")
      .filter((line) => line.includes("|||"))
      .map((line) => {
        const parts = line.split("|||");
        return {
          app: parts[0],
          title: parts[1],
          width: parseInt(parts[2]),
          height: parseInt(parts[3]),
          x: parseInt(parts[4]),
          y: parseInt(parts[5]),
        };
      })
      .filter((w) => w.app !== "Screen Studio");
  } catch {
    return [];
  }
}

interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function getDisplayBounds(): DisplayBounds[] {
  // Use NSScreen to get display bounds, then convert from Cocoa coordinates
  // (origin bottom-left of primary) to screen coordinates (origin top-left of primary)
  // which is what System Events window positions use.
  try {
    const raw = execSync(
      `osascript -e '
        use framework "AppKit"
        set screens to current application'"'"'s NSScreen'"'"'s screens()
        -- Get primary screen height for coordinate conversion
        set primaryFrame to (item 1 of screens)'"'"'s frame()
        set primaryHeight to (item 2 of item 2 of primaryFrame) as integer
        set output to ""
        repeat with s in screens
          set f to s'"'"'s frame()
          set cocoaX to (item 1 of item 1 of f) as integer
          set cocoaY to (item 2 of item 1 of f) as integer
          set w to (item 1 of item 2 of f) as integer
          set h to (item 2 of item 2 of f) as integer
          -- Convert: screenY = primaryHeight - cocoaY - h
          set screenY to primaryHeight - cocoaY - h
          set output to output & cocoaX & "|||" & screenY & "|||" & w & "|||" & h & "\\n"
        end repeat
        return output
      '`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();

    return raw
      .split("\n")
      .filter((line) => line.includes("|||"))
      .map((line) => {
        const parts = line.split("|||");
        return {
          x: parseInt(parts[0]),
          y: parseInt(parts[1]),
          width: parseInt(parts[2]),
          height: parseInt(parts[3]),
        };
      });
  } catch {
    return [];
  }
}

function windowIsOnDisplay(win: WindowInfo, display: DisplayBounds): boolean {
  // A window is on a display if its top-left corner falls within the display bounds
  return (
    win.x >= display.x &&
    win.x < display.x + display.width &&
    win.y >= display.y &&
    win.y < display.y + display.height
  );
}

function getWindowsOnDisplay(windows: WindowInfo[], display: DisplayBounds): WindowInfo[] {
  return windows.filter((w) => windowIsOnDisplay(w, display));
}

async function dismissPicker(port: number): Promise<void> {
  const url = `http://localhost:${port}/json`;
  try {
    const res = await fetch(url);
    const pages: Array<{ id: string; url: string; webSocketDebuggerUrl: string }> = await res.json();
    const overlays = pages.filter((p) => !p.url.includes("index.html"));

    if (overlays.length <= 1) return; // Only the preview child window, no picker

    // Click the RecordingPicker__UICloseButton (must be exact — clicking the
    // parent UIClose wrapper doesn't work and may open new pages instead)
    for (const page of overlays) {
      try {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        const found = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => { ws.close(); resolve(false); }, 2000);
          ws.onopen = () => {
            ws.send(JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: {
                expression: `var btn = document.querySelector("[class*='RecordingPicker__UICloseButton']"); if (btn) { btn.click(); true; } else { false; }`,
                returnByValue: true,
              },
            }));
          };
          ws.onmessage = (e) => {
            const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
            if (msg.id === 1) {
              clearTimeout(timeout);
              const clicked = msg.result?.result?.value === true;
              ws.close();
              resolve(clicked);
            }
          };
          ws.onerror = () => { clearTimeout(timeout); resolve(false); };
        });
        if (found) {
          await new Promise((r) => setTimeout(r, 500));
          return;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // non-critical
  }
}

interface OverlayWindow {
  pageId: string;
  wsUrl: string;
  app: string;
  width: number;
  height: number;
  top: number;
  left: number;
  highlightIndex: number;
}

async function findOverlayWindows(port: number): Promise<OverlayWindow[]> {
  const url = `http://localhost:${port}/json`;
  let pages: Array<{ id: string; url: string; webSocketDebuggerUrl: string }>;
  try {
    const res = await fetch(url);
    pages = await res.json();
  } catch {
    return [];
  }

  const nonMain = pages.filter((p) => !p.url.includes("index.html"));
  const results: OverlayWindow[] = [];

  for (const page of nonMain) {
    try {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      const result = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, 2000);
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: {
                expression: `
                  var highlights = document.querySelectorAll("[class*='SingleWindowHighlight__UIWindowSquare']");
                  if (highlights.length === 0) ""
                  else {
                    var result = [];
                    highlights.forEach(function(h, i) {
                      var appEl = h.querySelector("[class*='UIAppName']");
                      var dimEl = h.querySelector("[class*='UIDimension']");
                      if (appEl) {
                        var dimText = dimEl ? dimEl.textContent : "";
                        var match = dimText.match(/(\\d+)\\s*[×x]\\s*(\\d+)/);
                        var style = h.getAttribute("style") || "";
                        var topMatch = style.match(/top:\\s*(-?\\d+)/);
                        var leftMatch = style.match(/left:\\s*(-?\\d+)/);
                        result.push({
                          app: appEl.textContent.trim(),
                          width: match ? parseInt(match[1]) : 0,
                          height: match ? parseInt(match[2]) : 0,
                          top: topMatch ? parseInt(topMatch[1]) : 0,
                          left: leftMatch ? parseInt(leftMatch[1]) : 0,
                          index: i,
                        });
                      }
                    });
                    JSON.stringify(result);
                  }
                `,
                returnByValue: true,
              },
            }),
          );
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(
            typeof e.data === "string" ? e.data : e.data.toString(),
          );
          if (msg.id === 1) {
            clearTimeout(timeout);
            resolve(msg.result?.result?.value || null);
            ws.close();
          }
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          resolve(null);
        };
      });

      if (result && result.length > 2) {
        const windows = JSON.parse(result) as Array<{
          app: string;
          width: number;
          height: number;
          top: number;
          left: number;
          index: number;
        }>;
        for (const w of windows) {
          results.push({
            pageId: page.id,
            wsUrl: page.webSocketDebuggerUrl,
            app: w.app,
            width: w.width,
            height: w.height,
            top: w.top,
            left: w.left,
            highlightIndex: w.index,
          });
        }
      }
    } catch {
      // skip
    }
  }

  return results;
}

async function clickWindowHighlight(
  overlay: OverlayWindow,
): Promise<boolean> {
  const ws = new WebSocket(overlay.wsUrl);
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 3000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression: `
              var highlights = document.querySelectorAll("[class*='SingleWindowHighlight__UIWindowSquare']");
              var target = highlights[${overlay.highlightIndex}];
              if (target) { target.click(); true; } else { false; }
            `,
            returnByValue: true,
          },
        }),
      );
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(
        typeof e.data === "string" ? e.data : e.data.toString(),
      );
      if (msg.id === 1) {
        clearTimeout(timeout);
        const clicked = msg.result?.result?.value === true;
        if (clicked) {
          // Now click the record button that appears
          ws.send(
            JSON.stringify({
              id: 2,
              method: "Runtime.evaluate",
              params: {
                expression: `
                  setTimeout(function() {
                    var btn = document.querySelector("[data-kind=primary]");
                    if (btn) btn.click();
                  }, 300);
                  true;
                `,
                returnByValue: true,
              },
            }),
          );
        } else {
          ws.close();
          resolve(false);
        }
      }
      if (msg.id === 2) {
        ws.close();
        resolve(true);
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
  });
}

function matchWindow(
  windows: WindowInfo[],
  overlays: OverlayWindow[],
  search: string,
): { window: WindowInfo; overlay: OverlayWindow } | null {
  // Find the window whose title matches the search
  const searchLower = search.toLowerCase();
  const matched = windows.find(
    (w) =>
      w.title.toLowerCase().includes(searchLower) ||
      w.app.toLowerCase().includes(searchLower),
  );
  if (!matched) return null;

  // Find overlays matching this window by app name and size
  const candidates = overlays.filter(
    (o) =>
      o.app === matched.app &&
      o.width === matched.width &&
      o.height === matched.height,
  );

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { window: matched, overlay: candidates[0] };

  // Multiple candidates with same app+size on different overlay pages (displays).
  // Each overlay page = one display. Identify which display the target window is on
  // by finding a unique "anchor" window on each page — a window with a unique
  // app+size combo that only appears once, letting us map the page to an AppleScript
  // window position and thus a display.
  //
  // Group overlays by page
  const pageMap = new Map<string, OverlayWindow[]>();
  for (const o of overlays) {
    const list = pageMap.get(o.pageId) || [];
    list.push(o);
    pageMap.set(o.pageId, list);
  }

  // For each page, find an anchor: a window whose app+size is unique across all overlays
  for (const [pageId, pageOverlays] of pageMap) {
    for (const po of pageOverlays) {
      // Is this overlay's app+size unique across all overlay pages?
      const allMatching = overlays.filter(
        (o) => o.app === po.app && o.width === po.width && o.height === po.height,
      );
      if (allMatching.length === 1) {
        // This is a unique anchor — find its AppleScript counterpart
        const asMatch = windows.find(
          (w) => w.app === po.app && w.width === po.width && w.height === po.height,
        );
        if (asMatch) {
          // Now we know this page corresponds to the display containing asMatch.
          // Check if our target window is on the same display by comparing
          // AppleScript positions: windows on the same display have similar x offsets
          // (within the display width). The anchor's x tells us the display's x origin.
          // If the target's x is close to the anchor's x (within display width),
          // they're on the same display.
          const displayWidth = 2560; // reasonable max
          const sameDisplay = Math.abs(matched.x - asMatch.x) < displayWidth;
          if (sameDisplay) {
            // The target is on this page — find the matching candidate
            const candidate = candidates.find((c) => c.pageId === pageId);
            if (candidate) return { window: matched, overlay: candidate };
          }
        }
      }
    }
  }

  // Fallback: if no anchor found, try matching by page window count.
  // The page with fewer total windows is more likely to be a dedicated display.
  // Sort candidates by page size (fewer windows = more specific match).
  const sorted = [...candidates].sort((a, b) => {
    const aCount = pageMap.get(a.pageId)?.length || 0;
    const bCount = pageMap.get(b.pageId)?.length || 0;
    return aCount - bCount;
  });

  return { window: matched, overlay: sorted[0] };
}

const recordStart = new Command("start")
  .description("Start a new recording")
  .option("--mode <mode>", "Recording mode: display, window, or area", "display")
  .option("--display <index>", "Display index to record (0-based)")
  .option("--title <search>", "Window title to search for (window mode)")
  .option("--app <name>", "Auto-detect display containing this app (display mode)")
  .option("--delay <ms>", "Delay before auto-selecting (ms)", "1500")
  .action(async (opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;
    const mode = opts.mode as string;
    let displayIndex = opts.display !== undefined ? parseInt(opts.display) : 0;
    const delay = parseInt(opts.delay);
    const titleSearch = opts.title as string | undefined;
    const appSearch = opts.app as string | undefined;

    // Get window list before triggering picker (for title/app matching)
    const windowList = (mode === "window" || appSearch) ? getWindowList() : [];

    // If --app is specified in display mode, find which display contains that app
    if (mode === "display" && appSearch && opts.display === undefined) {
      const searchLower = appSearch.toLowerCase();
      const matchedWindow = windowList.find(
        (w) =>
          w.app.toLowerCase().includes(searchLower) ||
          w.title.toLowerCase().includes(searchLower),
      );
      if (matchedWindow) {
        const displayBounds = getDisplayBounds();
        const matchedDisplayIdx = displayBounds.findIndex((db) =>
          windowIsOnDisplay(matchedWindow, db),
        );
        if (matchedDisplayIdx >= 0) {
          // The display bounds order may not match the picker overlay order.
          // We need to map by resolution + elimination. For now, trigger the
          // picker and match the overlay by display resolution.
          displayIndex = matchedDisplayIdx;
          // We'll resolve the actual picker index after triggering
        }
      } else {
        output(
          {
            error: `No window found matching "${appSearch}"`,
            availableWindows: windowList.map((w) => `${w.app}: ${w.title}`),
          },
          json,
        );
        return;
      }
    }

    // Step 1: Trigger the picker
    const triggerResult = await withClient(port, async (client) => {
      return client.evaluate(`
        ${CACHE_RECORD_FNS}
        var mode = ${JSON.stringify(mode)};
        var fn = window.__recordFns[mode];
        if (!fn) return { error: 'Record function not found for mode: ' + mode + '. Available: ' + Object.keys(window.__recordFns).join(', ') };
        fn();
        return { triggered: true, mode: mode };
      `);
    });

    const result = triggerResult as Record<string, unknown>;
    if (result.error) {
      output(result, json);
      return;
    }

    // Step 2: Wait for overlays to appear
    await new Promise((r) => setTimeout(r, delay));

    if (mode === "window" && titleSearch) {
      // Window mode with title search — match by title
      const overlays = await findOverlayWindows(port);

      const match = matchWindow(windowList, overlays, titleSearch);
      if (!match) {
        // Dismiss the picker
        await dismissPicker(port);
        output(
          {
            error: `No window found matching "${titleSearch}"`,
            availableWindows: windowList.map((w) => `${w.app}: ${w.title} (${w.width}×${w.height})`),
          },
          json,
        );
        return;
      }

      const clicked = await clickWindowHighlight(match.overlay);
      if (!clicked) {
        output({ error: "Failed to click the window overlay" }, json);
        return;
      }

      // Wait for recording to actually start
      await new Promise((r) => setTimeout(r, 500));

      output(
        {
          success: true,
          mode: "window",
          app: match.window.app,
          title: match.window.title,
          size: `${match.window.width}×${match.window.height}`,
          message: "Recording started",
        },
        json,
      );
    } else if (mode === "display") {
      // Display mode — find the right display overlay and click its record button
      const url = `http://localhost:${port}/json`;
      const res = await fetch(url);
      const pages: Array<{
        id: string;
        url: string;
        webSocketDebuggerUrl: string;
      }> = await res.json();
      const nonMain = pages.filter((p) => !p.url.includes("index.html"));

      // Find pages with DisplayCoverWindow and extract their name + resolution
      const displayPages: Array<{
        wsUrl: string;
        name: string;
        dim: string;
        resW: number;
        resH: number;
      }> = [];
      for (const page of nonMain) {
        try {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          const result = await new Promise<string | null>((resolve) => {
            const timeout = setTimeout(() => {
              ws.close();
              resolve(null);
            }, 2000);
            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  id: 1,
                  method: "Runtime.evaluate",
                  params: {
                    expression: `
                      var holder = document.querySelector("[class*='DisplayCoverWindow']");
                      if (!holder) ""
                      else {
                        var nameEl = document.querySelector("[class*='UIAppName']");
                        var dimEl = document.querySelector("[class*='UIDimension']");
                        JSON.stringify({ name: nameEl ? nameEl.textContent : "Unknown", dim: dimEl ? dimEl.textContent : "" });
                      }
                    `,
                    returnByValue: true,
                  },
                }),
              );
            };
            ws.onmessage = (e) => {
              const msg = JSON.parse(
                typeof e.data === "string" ? e.data : e.data.toString(),
              );
              if (msg.id === 1) {
                clearTimeout(timeout);
                resolve(msg.result?.result?.value || null);
                ws.close();
              }
            };
            ws.onerror = () => {
              clearTimeout(timeout);
              resolve(null);
            };
          });

          if (result && result.length > 2) {
            const info = JSON.parse(result);
            const dimMatch = info.dim.match(/(\d+)\s*[×x]\s*(\d+)/);
            displayPages.push({
              wsUrl: page.webSocketDebuggerUrl,
              name: info.name,
              dim: info.dim,
              resW: dimMatch ? parseInt(dimMatch[1]) : 0,
              resH: dimMatch ? parseInt(dimMatch[2]) : 0,
            });
          }
        } catch {
          // skip
        }
      }

      // If --app was specified, use the window picker to find which display
      // page contains the target app, then map that to the display picker index.
      if (appSearch && opts.display === undefined) {
        // Dismiss the display picker first
        await dismissPicker(port);
        await new Promise((r) => setTimeout(r, 500));

        // Open the window picker to find which page has the target app
        await withClient(port, async (client) => {
          return client.evaluate(`
            ${CACHE_RECORD_FNS}
            if (window.__recordFns.window) { window.__recordFns.window(); }
            "triggered";
          `);
        });
        await new Promise((r) => setTimeout(r, delay));

        // Find overlay pages with window highlights and look for the target app
        const winOverlays = await findOverlayWindows(port);
        const searchLower = appSearch.toLowerCase();
        const targetOverlay = winOverlays.find(
          (o) => o.app.toLowerCase().includes(searchLower),
        );

        if (targetOverlay) {
          // Find which display picker page covers the same display as this
          // window overlay page. Window overlays and display overlays for the
          // same display share the same physical screen. We can match by
          // checking which display picker page has the same resolution as the
          // window overlay's display, using the overlay page ID ordering.
          //
          // Simpler: get all window overlay page IDs grouped by page, then
          // find the display picker index by matching page order.
          // The window picker pages appear in the same order as display picker pages.
          const windowPageIds = [...new Set(winOverlays.map((o) => o.pageId))];
          const targetPageIndex = windowPageIds.indexOf(targetOverlay.pageId);
          if (targetPageIndex >= 0 && targetPageIndex < displayPages.length) {
            displayIndex = targetPageIndex;
          }
        }

        // Dismiss window picker, then re-open display picker
        await dismissPicker(port);
        await new Promise((r) => setTimeout(r, 500));

        await withClient(port, async (client) => {
          return client.evaluate(`
            ${CACHE_RECORD_FNS}
            if (window.__recordFns.display) { window.__recordFns.display(); }
            "triggered";
          `);
        });
        await new Promise((r) => setTimeout(r, delay));

        // Re-fetch display pages since they're new overlay instances
        const res2 = await fetch(url);
        const pages2: Array<{ id: string; url: string; webSocketDebuggerUrl: string }> = await res2.json();
        const nonMain2 = pages2.filter((p) => !p.url.includes("index.html"));
        displayPages.length = 0;
        for (const page of nonMain2) {
          try {
            const ws = new WebSocket(page.webSocketDebuggerUrl);
            const result = await new Promise<string | null>((resolve) => {
              const timeout = setTimeout(() => { ws.close(); resolve(null); }, 2000);
              ws.onopen = () => {
                ws.send(JSON.stringify({
                  id: 1, method: "Runtime.evaluate", params: {
                    expression: `
                      var holder = document.querySelector("[class*='DisplayCoverWindow']");
                      if (!holder) ""
                      else {
                        var nameEl = document.querySelector("[class*='UIAppName']");
                        var dimEl = document.querySelector("[class*='UIDimension']");
                        JSON.stringify({ name: nameEl ? nameEl.textContent : "Unknown", dim: dimEl ? dimEl.textContent : "" });
                      }
                    `,
                    returnByValue: true,
                  },
                }));
              };
              ws.onmessage = (e) => {
                const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
                if (msg.id === 1) { clearTimeout(timeout); resolve(msg.result?.result?.value || null); ws.close(); }
              };
              ws.onerror = () => { clearTimeout(timeout); resolve(null); };
            });
            if (result && result.length > 2) {
              const info = JSON.parse(result);
              const dimMatch = info.dim.match(/(\d+)\s*[×x]\s*(\d+)/);
              displayPages.push({
                wsUrl: page.webSocketDebuggerUrl, name: info.name, dim: info.dim,
                resW: dimMatch ? parseInt(dimMatch[1]) : 0, resH: dimMatch ? parseInt(dimMatch[2]) : 0,
              });
            }
          } catch { /* skip */ }
        }
      }

      const target = displayPages[displayIndex] || displayPages[0];
      if (!target) {
        output({ error: "No display overlays found" }, json);
        return;
      }

      // Click the record button
      const ws = new WebSocket(target.wsUrl);
      const clicked = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 3000);
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: {
                expression: `var btn = document.querySelector("[data-kind=primary]"); if (btn) { btn.click(); true; } else { false; }`,
                returnByValue: true,
              },
            }),
          );
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(
            typeof e.data === "string" ? e.data : e.data.toString(),
          );
          if (msg.id === 1) {
            clearTimeout(timeout);
            resolve(msg.result?.result?.value === true);
            ws.close();
          }
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          resolve(false);
        };
      });

      if (!clicked) {
        output({ error: "Failed to click the display overlay" }, json);
        return;
      }

      output(
        {
          success: true,
          mode: "display",
          display: `${target.name} (${target.dim})`,
          message: "Recording started",
        },
        json,
      );
    } else {
      // Window mode without title, or area mode — just click the first primary button
      const url = `http://localhost:${port}/json`;
      const res = await fetch(url);
      const pages: Array<{
        id: string;
        url: string;
        webSocketDebuggerUrl: string;
      }> = await res.json();
      const nonMain = pages.filter((p) => !p.url.includes("index.html"));

      let clicked = false;
      let clickedName = "";
      for (const page of nonMain) {
        try {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          const result = await new Promise<string | null>((resolve) => {
            const timeout = setTimeout(() => {
              ws.close();
              resolve(null);
            }, 2000);
            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  id: 1,
                  method: "Runtime.evaluate",
                  params: {
                    expression: `
                      var btn = document.querySelector("[data-kind=primary]");
                      var nameEl = document.querySelector("[class*='UIAppName']");
                      if (btn) { btn.click(); JSON.stringify({ clicked: true, name: nameEl ? nameEl.textContent : "" }); }
                      else { "" }
                    `,
                    returnByValue: true,
                  },
                }),
              );
            };
            ws.onmessage = (e) => {
              const msg = JSON.parse(
                typeof e.data === "string" ? e.data : e.data.toString(),
              );
              if (msg.id === 1) {
                clearTimeout(timeout);
                resolve(msg.result?.result?.value || null);
                ws.close();
              }
            };
            ws.onerror = () => {
              clearTimeout(timeout);
              resolve(null);
            };
          });

          if (result && result.length > 2) {
            const info = JSON.parse(result);
            if (info.clicked) {
              clicked = true;
              clickedName = info.name;
              break;
            }
          }
        } catch {
          // skip
        }
      }

      if (!clicked) {
        output({ error: "Could not find or click any overlay" }, json);
        return;
      }

      output(
        {
          success: true,
          mode,
          target: clickedName,
          message: "Recording started",
        },
        json,
      );
    }
  });

const recordStop = new Command("stop")
  .description("Stop recording and save the project")
  .action(async (_opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    await withClient(port, async (client) => {
      return client.evaluate(`
        await bridge.client.mutation("capture.finish");
      `);
    });

    await new Promise((r) => setTimeout(r, 1500));

    // Dismiss the picker overlay that reappears after stop
    await dismissPicker(port);

    output({ success: true, message: "Recording stopped and saved" }, json);
  });

const recordCancel = new Command("cancel")
  .description("Cancel recording and discard")
  .action(async (_opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    await withClient(port, async (client) => {
      return client.evaluate(`
        await bridge.client.mutation("capture.cancel");
      `);
    });

    await new Promise((r) => setTimeout(r, 500));

    // Dismiss the picker overlay that reappears after cancel.
    // Wait for overlays to fully appear, then dismiss via CDP.
    await new Promise((r) => setTimeout(r, 1500));
    await dismissPicker(port);

    output({ success: true, message: "Recording cancelled and discarded" }, json);
  });

const recordPause = new Command("pause")
  .description("Pause the current recording")
  .action(async (_opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    await withClient(port, async (client) => {
      return client.evaluate(`
        await bridge.client.mutation("capture.pause");
      `);
    });

    await new Promise((r) => setTimeout(r, 500));

    output({ success: true, message: "Recording paused" }, json);
  });

const recordResume = new Command("resume")
  .description("Resume a paused recording")
  .action(async (_opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    await withClient(port, async (client) => {
      return client.evaluate(`
        await bridge.client.mutation("capture.resume");
      `);
    });

    await new Promise((r) => setTimeout(r, 500));

    output({ success: true, message: "Recording resumed" }, json);
  });

const recordWindows = new Command("windows")
  .description("List available windows for recording (with titles)")
  .action(async (_opts, cmd) => {
    const json = cmd.parent?.parent?.opts().json || false;

    const windows = getWindowList();

    if (json) {
      output(windows, true);
    } else {
      if (windows.length === 0) {
        console.log("No visible windows found.");
      } else {
        const rows = windows.map((w) => [
          w.app,
          w.title.length > 60 ? w.title.slice(0, 57) + "..." : w.title,
          `${w.width}×${w.height}`,
        ]);
        table(["App", "Title", "Size"], rows);
        console.log(
          `\nUse: screenstudio record start --mode window --title "<search>"`,
        );
      }
    }
  });

const recordDisplays = new Command("displays")
  .description("List available displays with the apps visible on each")
  .action(async (_opts, cmd) => {
    const port = parseInt(cmd.parent?.parent?.opts().port || "9222");
    const json = cmd.parent?.parent?.opts().json || false;

    // Step 1: Open window picker to discover which apps are on which display page
    await withClient(port, async (client) => {
      return client.evaluate(`
        ${CACHE_RECORD_FNS}
        if (window.__recordFns.window) { window.__recordFns.window(); }
        "triggered";
      `);
    });
    await new Promise((r) => setTimeout(r, 1500));

    // Get window overlays — each page = one display, with the apps shown on it
    const winOverlays = await findOverlayWindows(port);
    const windowPageIds = [...new Set(winOverlays.map((o) => o.pageId))];
    const appsPerPage: Map<string, string[]> = new Map();
    for (const o of winOverlays) {
      const list = appsPerPage.get(o.pageId) || [];
      const label = `${o.app} (${o.width}×${o.height})`;
      if (!list.includes(label)) list.push(label);
      appsPerPage.set(o.pageId, list);
    }

    // Dismiss window picker
    await dismissPicker(port);
    await new Promise((r) => setTimeout(r, 500));

    // Step 2: Open display picker to get display names/resolutions
    await withClient(port, async (client) => {
      return client.evaluate(`
        ${CACHE_RECORD_FNS}
        if (window.__recordFns.display) { window.__recordFns.display(); }
        "triggered";
      `);
    });
    await new Promise((r) => setTimeout(r, 1500));

    const url = `http://localhost:${port}/json`;
    const res = await fetch(url);
    const pages: Array<{
      id: string;
      url: string;
      webSocketDebuggerUrl: string;
    }> = await res.json();
    const nonMain = pages.filter((p) => !p.url.includes("index.html"));

    interface DisplayInfo {
      index: number;
      name: string;
      resolution: string;
      apps: string[];
    }
    const displays: DisplayInfo[] = [];

    for (const page of nonMain) {
      try {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        const result = await new Promise<string | null>((resolve) => {
          const timeout = setTimeout(() => { ws.close(); resolve(null); }, 2000);
          ws.onopen = () => {
            ws.send(JSON.stringify({
              id: 1, method: "Runtime.evaluate", params: {
                expression: `
                  var holder = document.querySelector("[class*='DisplayCoverWindow']");
                  if (!holder) ""
                  else {
                    var nameEl = document.querySelector("[class*='UIAppName']");
                    var dimEl = document.querySelector("[class*='UIDimension']");
                    JSON.stringify({ name: nameEl ? nameEl.textContent : "Unknown", dim: dimEl ? dimEl.textContent : "" });
                  }
                `,
                returnByValue: true,
              },
            }));
          };
          ws.onmessage = (e) => {
            const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
            if (msg.id === 1) { clearTimeout(timeout); resolve(msg.result?.result?.value || null); ws.close(); }
          };
          ws.onerror = () => { clearTimeout(timeout); resolve(null); };
        });

        if (result && result.length > 2) {
          const info = JSON.parse(result);
          // Map to the corresponding window picker page by index
          // Window picker and display picker pages appear in the same order
          const pageId = windowPageIds[displays.length];
          const apps = pageId ? (appsPerPage.get(pageId) || []) : [];
          displays.push({
            index: displays.length,
            name: info.name,
            resolution: info.dim,
            apps,
          });
        }
      } catch { /* skip */ }
    }

    // Dismiss display picker
    await dismissPicker(port);

    if (json) {
      output(displays, true);
    } else {
      if (displays.length === 0) {
        console.log("No displays found.");
      } else {
        for (const d of displays) {
          console.log(`  ${d.index}: ${d.name} — ${d.resolution}`);
          if (d.apps.length > 0) {
            for (const app of d.apps) {
              console.log(`       ${app}`);
            }
          } else {
            console.log(`       (no visible windows)`);
          }
        }
        console.log(`\nUse: screenstudio record start --display <index>`);
        console.log(`  or: screenstudio record start --app <name>`);
      }
    }
  });

export const recordCommand = new Command("record")
  .description("Record screen, window, or area")
  .addCommand(recordStart)
  .addCommand(recordStop)
  .addCommand(recordCancel)
  .addCommand(recordPause)
  .addCommand(recordResume)
  .addCommand(recordWindows)
  .addCommand(recordDisplays);
