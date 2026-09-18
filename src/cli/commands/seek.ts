import { Command } from "commander";
import { CDPClient, withClient } from "../../cdp/client.js";
import { findPreviewPage } from "../../cdp/page-finder.js";
import { output } from "../format.js";
import { numberValue, PROJECT_LOOKUP } from "../validation.js";

// Read the current tree every time: cached callbacks still point at closed
// editors after a project is reopened. Match the active project's context.
const FIND_SEEK_FN = `
  {
    window.__seekFn = window.__clickFn = window.__seekStopFn = window.__seekPlayback = null;
    var root = document.getElementById('root');
    var fiberKey = root && Object.keys(root).find(function(k) { return k.startsWith('__reactContainer'); });
    var fiber = fiberKey && root[fiberKey];
    var queue = [fiber?.stateNode?.current || fiber];
    var visited = new Set();
    while (queue.length > 0 && visited.size < 10000) {
      var node = queue.shift();
      if (!node || visited.has(node)) continue;
      visited.add(node);
      if (typeof node.memoizedProps?.onTimeClick === 'function') {
        var owner = node;
        while (owner) {
          var contextProject = owner.memoizedProps?.value?.project;
          if (contextProject) break;
          owner = owner.return;
        }
        if (contextProject === p) {
          window.__seekFn = node.memoizedProps.onTimeSeek;
          window.__clickFn = node.memoizedProps.onTimeClick;
          window.__seekStopFn = node.memoizedProps.onSeekStop;
          window.__seekPlayback = owner.memoizedProps.value.animationRef?.current?.playback;
          break;
        }
      }
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
    }
    if (!window.__clickFn) throw new Error('Could not find the active project timeline in this Screen Studio build.');
  }
`;

// The playhead can move before webcam/screen decoding has completed. Pause and
// wait for the native media blockers before capturing the requested frame.
const SEEK_TO_TIME = `
  if (typeof window.__seekPlayback?.pauseAt === 'function') {
    window.__seekPlayback.pauseAt(targetMs);
    await window.__seekPlayback.waitForFrameReady();
  } else {
    window.__clickFn(targetMs);
  }
`;

// JS to find the Pixi renderer in the child window and force a re-render
const INIT_PIXI = `
  {
    // Layout/config edits can replace the canvas and destroy its renderer.
    window.__pixiComponent = window.__pixiApp = null;
    var canvas = document.querySelector('canvas');
    if (canvas) {
      var fiberKey = Object.keys(canvas).find(function(k) { return k.startsWith('__reactFiber'); });
      if (fiberKey) {
        var fiber = canvas[fiberKey];
        if (fiber.return && fiber.return.stateNode && fiber.return.stateNode.app) {
          window.__pixiComponent = fiber.return.stateNode;
          window.__pixiApp = fiber.return.stateNode.app;
        }
      }
    }
  }
`;

const FORCE_RENDER = `
  if (window.__pixiComponent) {
    window.__pixiComponent._needsUpdate = true;
    window.__pixiComponent.needsRenderUpdate();
    window.__pixiComponent.renderStage();
    window.__pixiComponent.app.renderer.render(window.__pixiComponent.app.stage);
  }
`;

// Paused HTML videos may finish seeking without refreshing their GPU texture
// while the preview ticker is idle. Wait for each seek and upload that frame.
const REFRESH_MEDIA = `
  if (window.__pixiApp) {
    var queue = [window.__pixiApp.stage], resources = new Set();
    while (queue.length) {
      var item = queue.shift();
      var resource = item.texture?.baseTexture?.resource;
      if (resource?.source?.tagName === 'VIDEO') resources.add(resource);
      if (item.children) queue.push(...item.children);
    }
    await Promise.all(Array.from(resources, async function(resource) {
      var video = resource.source;
      if (video.seeking) await new Promise(function(resolve, reject) {
        var cleanup = function() {
          clearTimeout(timer);
          video.removeEventListener('seeked', ready);
          video.removeEventListener('error', failed);
        };
        var ready = function() { cleanup(); resolve(); };
        var failed = function() { cleanup(); reject(new Error('Preview video seek failed')); };
        var timer = setTimeout(function() {
          cleanup(); reject(new Error('Preview video seek timed out'));
        }, 10000);
        video.addEventListener('seeked', ready, { once: true });
        video.addEventListener('error', failed, { once: true });
      });
      resource.update();
    }));
  }
`;

export { FIND_SEEK_FN, SEEK_TO_TIME, INIT_PIXI, FORCE_RENDER, REFRESH_MEDIA };

export const seekCommand = new Command("seek")
  .description("Move the playhead to a specific time (playback ms)")
  .argument("<timeMs>", "Playback time in milliseconds (or 'start' / 'end')")
  .action(async (timeArg, _opts, cmd) => {
    const port = parseInt(cmd.parent?.opts().port || "9222");
    const json = cmd.parent?.opts().json || false;

    let timeMs: number;
    if (timeArg === "start") {
      timeMs = 0;
    } else if (timeArg === "end") {
      timeMs = -1;
    } else {
      timeMs = numberValue(timeArg, "Playback time");
    }

    const result = await withClient(port, async (client) => {
      return client.evaluate(`
        ${PROJECT_LOOKUP}
        if (!p) return { error: 'No project open' };
        var targetMs = ${timeMs === -1 ? "p.playbackDurationMs" : timeMs};
        if (targetMs > p.playbackDurationMs) throw new Error('Seek time extends beyond the project.');
        ${FIND_SEEK_FN}
        ${SEEK_TO_TIME}
        return { success: true, seekedToMs: targetMs };
      `);
    });

    // Force re-render in the child window
    const preview = new CDPClient(port, 12_000);
    try {
      await preview.connect(await findPreviewPage(port));
      await preview.evaluate(`${INIT_PIXI} ${FORCE_RENDER} ${REFRESH_MEDIA} ${FORCE_RENDER}`);
    } catch {
      // Non-critical — preview just won't update
    } finally {
      preview.disconnect();
    }

    if (json) {
      output(result, true);
    } else {
      const r = result as Record<string, unknown>;
      if (r.error) {
        console.error(String(r.error));
        process.exit(1);
      }
      console.log(`Seeked to ${r.seekedToMs}ms`);
    }
  });
