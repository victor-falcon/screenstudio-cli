import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { CDPClient, withClient } from '../dist/cdp/client.js';
import { findRendererPage, findPreviewPage } from '../dist/cdp/page-finder.js';
import { mockCDP } from './helpers/cdp.mjs';

test('awaits asynchronous app operations and returns structured results', async t => {
  const { requests } = mockCDP(t);
  const value = await withClient(9222, c => c.evaluate('await new Promise(r => setTimeout(r, 5)); return { saved: true };'));
  assert.deepEqual(value, { saved: true });
  assert.equal(requests[0].params.awaitPromise, true);
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
  for (const type of ['message', 'close', 'error']) assert.equal(getEventListeners(sockets[0], type).length, 0);
  client.disconnect();
});

test('connect failures close the socket through withClient', async t => {
  const { sockets } = mockCDP(t, {}, { failConnect: true });
  await assert.rejects(withClient(9222, c => c.evaluate('return 1')), /Failed to connect/);
  assert.equal(sockets[0].readyState, 3);
});

test('awaits both key events', async t => {
  const { requests } = mockCDP(t);
  await withClient(9222, c => c.dispatchKeyEvent('e', 'KeyE', 9));
  assert.deepEqual(requests.map(r => r.params.type), ['keyDown', 'keyUp']);
});

test('target discovery ignores workers and rejects invalid HTTP responses', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    { type: 'worker', url: 'app.asar/dist/index.html', webSocketDebuggerUrl: 'wrong' },
    { type: 'page', url: 'app.asar/dist/index.html', webSocketDebuggerUrl: 'correct' },
  ])));
  assert.equal(await findRendererPage(9222), 'correct');
  globalThis.fetch.mock.mockImplementation(async () => new Response('', { status: 503 }));
  await assert.rejects(findRendererPage(9222), /HTTP 503/);
  await assert.rejects(findRendererPage(NaN), /CDP port/);
});

test('preview discovery ignores non-page targets and refuses ambiguous auxiliary windows', async t => {
  const pages = [
    null,
    { type: 'page', url: 'app.asar/dist/index.html', webSocketDebuggerUrl: 'main' },
    { type: 'worker', url: 'worker.js', webSocketDebuggerUrl: 'worker' },
    { type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'devtools' },
    { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'preview' },
  ];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(pages)));
  assert.equal(await findPreviewPage(9222), 'preview');
  pages.push({ type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'other-project' });
  await assert.rejects(findPreviewPage(9222), /Multiple auxiliary windows/);
});
