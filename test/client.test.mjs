import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { CDPClient, withClient } from '../dist/cdp/client.js';
import vm from 'node:vm';
import { findRendererPage } from '../dist/cdp/page-finder.js';
import { mockCDP } from './helpers/cdp.mjs';

test('awaits asynchronous app operations and returns structured results', async t => {
  const { requests } = mockCDP(t);
  const value = await withClient(9222, c => c.evaluate('await new Promise(r => setTimeout(r, 5)); return { saved: true };'));
  assert.deepEqual(value, { saved: true });
  assert.equal(requests.at(-1).params.awaitPromise, true);
});

test('propagates rejected IPC promises and validation errors', async t => {
  mockCDP(t);
  await assert.rejects(withClient(9222, c => c.evaluate('await Promise.reject(new Error("save failed"));')), /save failed/);
  await assert.rejects(withClient(9222, c => c.evaluate('return { error: "No project open" };')), /No project/);
  await assert.rejects(withClient(9222, c => c.evaluate('throw null;')), { message: 'null' });
  await assert.rejects(withClient(9222, c => c.evaluate('throw undefined;')), { message: 'undefined' });
});

test('raw execution awaits promises, serializes objects, and reports exceptions', async t => {
  mockCDP(t);
  assert.equal(await withClient(9222, c => c.evaluateRaw('Promise.resolve({ value: 4 })')), '{"value":4}');
  await assert.rejects(withClient(9222, c => c.evaluateRaw('throw new Error("invalid")')), /invalid/);
});

test('reports protocol errors instead of resolving undefined', async t => {
  mockCDP(t, {}, { onRequest: (r, ws) => ws.reply({ id: r.id, error: { message: 'Method not found' } }) });
  await assert.rejects(withClient(9222, c => c.evaluate('return 1')), /Method not found/);
});

test('rejects a pending operation when the connection closes', async t => {
  mockCDP(t, {}, { onRequest: (_r, ws) => ws.close() });
  await assert.rejects(withClient(9222, c => c.evaluate('return 1')), /disconnected/);
});

test('timeouts remove response listeners', async t => {
  const { sockets } = mockCDP(t, {}, { onRequest: () => {} });
  const client = new CDPClient(9222, 10);
  await client.connect();
  await assert.rejects(client.evaluate('return 1'), /timed out/);
  for (const type of ['message', 'close', 'error']) assert.equal(getEventListeners(sockets.at(-1), type).length, 0);
  client.disconnect();
});

test('connect failures close the socket through withClient', async t => {
  const { sockets } = mockCDP(t, {}, { failConnect: true });
  await assert.rejects(withClient(9222, c => c.evaluate('return 1'), 'ws://127.0.0.1:9222/devtools/page/test'), /Failed to connect/);
  assert.equal(sockets[0].readyState, 3);
});

test('target discovery skips the hidden render worker, which also loads index.html', async t => {
  const main = vm.createContext({ electronEnv: { IS_RENDER_WORKER: false }, $projects: new Set() });
  main.window = main;
  const worker = vm.createContext({ electronEnv: { IS_RENDER_WORKER: true } });
  worker.window = worker;
  mockCDP(t, {}, {
    pages: [
      { type: 'worker', url: 'app.asar/dist/index.html', webSocketDebuggerUrl: 'shared-worker' },
      { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'editor-window' },
      { type: 'page', url: 'app.asar/dist/index.html', webSocketDebuggerUrl: 'render-worker' },
      { type: 'page', url: 'app.asar/dist/index.html', webSocketDebuggerUrl: 'main' },
    ],
    contexts: { 'render-worker': worker, main },
  });
  assert.equal(await findRendererPage(9222), 'main');
});

test('target discovery reports a main window that is not ready and invalid HTTP responses', async t => {
  const worker = vm.createContext({ electronEnv: { IS_RENDER_WORKER: true } });
  worker.window = worker;
  mockCDP(t, {}, { pages: [{ type: 'page', url: 'app.asar/dist/index.html', webSocketDebuggerUrl: 'w' }], contexts: { w: worker } });
  await assert.rejects(findRendererPage(9222), /not ready/);
  globalThis.fetch.mock.mockImplementation(async () => new Response('', { status: 503 }));
  await assert.rejects(findRendererPage(9222), /HTTP 503/);
  await assert.rejects(findRendererPage(NaN), /CDP port/);
});
