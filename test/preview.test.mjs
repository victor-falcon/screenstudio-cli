import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INIT_PIXI, REFRESH_MEDIA, SEEK_TO_TIME } from '../dist/cli/commands/seek.js';
import { mockCDP, runCommand } from './helpers/cdp.mjs';

test('preview uses the replacement renderer after a layout edit', () => {
  const oldRenderer = { app: {} }, newRenderer = { app: {} };
  let canvas = { __reactFiber$test: { return: { stateNode: oldRenderer } } };
  const context = vm.createContext({ document: { querySelector: () => canvas } });
  context.window = context;
  vm.runInContext(INIT_PIXI, context);
  assert.equal(context.__pixiComponent, oldRenderer);
  canvas = { __reactFiber$test: { return: { stateNode: newRenderer } } };
  vm.runInContext(INIT_PIXI, context);
  assert.equal(context.__pixiComponent, newRenderer);
  assert.equal(context.__pixiApp, newRenderer.app);
  canvas = null;
  vm.runInContext(INIT_PIXI, context);
  assert.equal(context.__pixiComponent, null);
});

test('seeking pauses playback and awaits media readiness', async () => {
  let release, requestedTime, ready = false;
  const pending = new Promise(resolve => { release = resolve; });
  const playback = {
    pauseAt(time) { requestedTime = time; },
    async waitForFrameReady() { await pending; ready = true; },
  };
  const context = vm.createContext({ targetMs: 22380, __seekPlayback: playback });
  context.window = context;
  const seek = vm.runInContext(`(async () => { ${SEEK_TO_TIME} })()`, context);
  assert.equal(requestedTime, 22380);
  assert.equal(ready, false);
  release();
  await seek;
  assert.equal(ready, true);
});

test('paused screen and webcam textures refresh only after their individual seeks finish', async () => {
  function media() {
    const video = new EventTarget();
    Object.assign(video, { tagName: 'VIDEO', seeking: true, decodedFrame: 'old' });
    return { source: video, uploadedFrame: 'old', updates: 0,
      update() { this.uploadedFrame = video.decodedFrame; this.updates++; } };
  }
  const screen = media(), camera = media();
  const sprite = resource => ({ texture: { baseTexture: { resource } } });
  const context = vm.createContext({ setTimeout, clearTimeout, __pixiApp: {
    stage: { children: [sprite(screen), { children: [sprite(camera), sprite(screen)] }] },
  } });
  context.window = context;
  let finished = false;
  const refresh = vm.runInContext(`(async () => { ${REFRESH_MEDIA} })()`, context)
    .then(() => { finished = true; });
  assert.equal(screen.uploadedFrame, 'old');
  Object.assign(screen.source, { seeking: false, decodedFrame: 'puzzle' });
  screen.source.dispatchEvent(new Event('seeked'));
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(camera.uploadedFrame, 'old');
  Object.assign(camera.source, { seeking: false, decodedFrame: 'wave' });
  camera.source.dispatchEvent(new Event('seeked'));
  await refresh;
  assert.equal(screen.uploadedFrame, 'puzzle');
  assert.equal(camera.uploadedFrame, 'wave');
  assert.equal(screen.updates, 1);
  assert.equal(camera.updates, 1);
  // A completed seek still needs an upload when the preview ticker is idle.
  screen.source.decodedFrame = 'next puzzle';
  await vm.runInContext(`(async () => { ${REFRESH_MEDIA} })()`, context);
  assert.equal(screen.uploadedFrame, 'next puzzle');
});

function captureSetup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'screenstudio-preview-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "preview 'image' $(literal).png");
  const events = [], logs = [], image = Buffer.from('captured image');
  t.mock.method(console, 'log', value => logs.push(value));
  const project = { playbackDurationMs: 6000 };
  const playback = { pauseAt: time => events.push(`pause:${time}`),
    async waitForFrameReady() { events.push('ready'); } };
  const editor = { memoizedProps: { value: { project, animationRef: { current: { playback } } } } };
  editor.child = { memoizedProps: { onTimeClick() {} }, return: editor };
  const resource = { source: { tagName: 'VIDEO', seeking: false }, update() { events.push('upload'); } };
  const pixi = { needsRenderUpdate() {}, renderStage() {}, app: {
    stage: { texture: { baseTexture: { resource } } }, renderer: { render() { events.push('render'); } },
  } };
  const transport = mockCDP(t, {
    $project: project,
    document: {
      getElementById: () => ({ __reactContainer$test: { stateNode: { current: editor } } }),
      querySelector: () => ({ __reactFiber$test: { return: { stateNode: pixi } } }),
    },
  }, {
    pages: [
      { type: 'page', url: 'app.asar/dist/index.html', webSocketDebuggerUrl: 'ws://main' },
      { type: 'worker', url: 'worker.js', webSocketDebuggerUrl: 'ws://worker' },
      { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://preview' },
    ],
    onRequest(request, ws) {
      if (request.method === options.disconnectOn) return ws.close();
      if (request.method === options.failOn) return ws.reply({ id: request.id, error: { message: 'Capture failed' } });
      if (request.method === 'Runtime.evaluate') return false;
      assert.equal(ws.url, 'ws://preview');
      const responses = {
        'DOM.getDocument': { root: { nodeId: 1 } },
        'DOM.querySelector': { nodeId: options.noCanvas ? 0 : 2 },
        'DOM.getBoxModel': { model: { content: [10, 20, 650, 20, 650, 500, 10, 500] } },
        'Page.captureScreenshot': { data: image.toString('base64') },
      };
      if (request.method === 'Page.captureScreenshot') {
        events.push('screenshot');
        assert.deepEqual(request.params.clip, { x: 10, y: 20, width: 640, height: 480, scale: 2 });
      }
      ws.reply({ id: request.id, result: responses[request.method] });
    },
  });
  return { ...transport, path, events, logs, image };
}

test('preview captures only after rendering and refreshing media, writes the image, and honors JSON output', async t => {
  const { path, events, logs, image, sockets } = captureSetup(t);
  await runCommand('preview', ['--at', '1000', '--output', path]);
  assert.deepEqual(events, ['pause:1000', 'ready', 'render', 'ready', 'upload', 'render', 'screenshot']);
  assert.deepEqual(readFileSync(path), image);
  assert.deepEqual(JSON.parse(logs.at(-1)), { success: true, path });
  assert.ok(sockets.every(ws => ws.readyState === 3));
});

for (const [name, options, error] of [
  ['protocol errors', { failOn: 'Page.captureScreenshot' }, /Capture failed/],
  ['disconnections', { disconnectOn: 'DOM.getDocument' }, /disconnected/],
  ['a missing canvas', { noCanvas: true }, /Could not find the preview canvas/],
]) test(`preview reports ${name} without writing a file or claiming success`, async t => {
  const { path, logs, sockets } = captureSetup(t, options);
  await assert.rejects(runCommand('preview', ['--output', path]), error);
  assert.equal(existsSync(path), false);
  assert.equal(logs.length, 0);
  assert.ok(sockets.every(ws => ws.readyState === 3));
});
