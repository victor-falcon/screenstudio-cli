import vm from 'node:vm';
import { Command } from 'commander';

export function mockCDP(t, globals = {}, options = {}) {
  const requests = [], sockets = [];
  const context = vm.createContext({ setTimeout, clearTimeout, ...globals });
  context.window ??= context;
  class MockWebSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => {
        if (options.failConnect) this.dispatchEvent(new Event('error'));
        else { this.readyState = 1; this.dispatchEvent(new Event('open')); }
      });
    }
    send(data) {
      const request = JSON.parse(data);
      requests.push(request);
      if (options.onRequest && options.onRequest(request, this) !== false) return;
      void (async () => {
        try {
          const value = request.method === 'Runtime.evaluate'
            ? await vm.runInContext(request.params.expression, context) : undefined;
          this.reply({ id: request.id, result: { result: { type: typeof value, value } } });
        } catch (error) {
          this.reply({ id: request.id, result: { exceptionDetails: {
            text: 'Uncaught', exception: { description: String(error) },
          } } });
        }
      })();
    }
    reply(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(options.pages ?? [
    { type: 'page', url: 'file:///Applications/Screen%20Studio.app/Contents/Resources/app.asar/dist/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/test' },
  ])));
  const original = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  return { requests, sockets, context };
}

let sequence = 0;
export async function runCommand(name, args) {
  const module = await import(`../../dist/cli/commands/${name}.js?test=${++sequence}`);
  const program = new Command().exitOverride().option('--json').option('--port <port>', 'CDP port', '9222');
  program.addCommand(module[`${name}Command`]);
  const overrideExits = command => {
    command.exitOverride();
    command.commands.forEach(overrideExits);
  };
  overrideExits(program);
  await program.parseAsync(['--json', name, ...args], { from: 'user' });
}

// Small contract fixture for the model shapes inspected in Screen Studio 3.7.5.
// Not an emulation of rendering, IPC, or the app's MobX/Immer implementation.
export function projectFixture() {
  let nextId = 1;
  const calls = [], undo = [], redo = [];
  const state = {
    config: { audioVolume: 1, backgroundColor: '#000000', backgroundAudioFileName: null,
      backgroundAudioVolume: 0.05, muteBackgroundAudio: false, improveMicrophoneAudio: true,
      microphoneInStereoMode: false, muteMicrophone: false, muteSystemAudio: false,
      muteExternalDeviceAudio: false, clickSoundEffect: null, showTranscript: false,
      cursorSet: { id: 'macos', variants: {} }, deviceFrameKey: null },
    scene: { id: 'scene-1', name: 'Default', slices: [
      { id: 's1', sourceStartMs: 0, sourceEndMs: 5000, timeScale: 1, volume: 0.7,
        systemAudioVolume: 0.8, externalDeviceAudioVolume: 0.9, hideCursor: false,
        disableSmoothMouseMovement: false, futureField: 'keep' },
      { id: 's2', sourceStartMs: 5000, sourceEndMs: 10000, timeScale: 0.5, volume: 1,
        systemAudioVolume: 1, externalDeviceAudioVolume: 1, hideCursor: false,
        disableSmoothMouseMovement: false },
    ], masks: [], zoomRanges: [], layouts: [], voiceOvers: [] },
  };
  const snapshot = () => JSON.parse(JSON.stringify(state));
  function commit(fn) { undo.push(snapshot()); redo.length = 0; fn(); calls.push('update'); }
  const range = data => ({ ...data, data, sourceStartTime: data.startTime, sourceEndTime: data.endTime,
    duration: data.endTime - data.startTime });
  const scene = {
    get id() { return state.scene.id; }, get name() { return state.scene.name; },
    get masks() { return state.scene.masks.map(range); },
    get zoomRanges() { return state.scene.zoomRanges.map(range); },
    get layouts() { return state.scene.layouts.map(range); },
    get voiceOvers() { return state.scene.voiceOvers.map(range); },
    get slices() { return state.scene.slices.map((data, index) => ({ ...data, data, index,
      speed: 1 / data.timeScale, playbackStartMs: data.sourceStartMs, playbackEndMs: data.sourceEndMs,
    })); },
    update(patch) { commit(() => Object.assign(state.scene, JSON.parse(JSON.stringify(patch)))); },
    addMask(patch) {
      const data = { id: `mask-${nextId++}`, isDisabled: false, highlightMaskOpacity: 0.5, ...JSON.parse(JSON.stringify(patch)) };
      commit(() => { state.scene.masks.push(data); state.scene.masks.sort((a, b) => a.startTime - b.startTime); });
      return range(data);
    },
    updateMask(id, patch) { commit(() => Object.assign(state.scene.masks.find(m => m.id === id), JSON.parse(JSON.stringify(patch)))); },
    removeMask(id) { commit(() => { state.scene.masks = state.scene.masks.filter(m => m.id !== id); }); },
  };
  const project = {
    name: 'Fixture', path: '/tmp/test.screenstudio', isDirty: true,
    // Screen Studio's project getters are not reliable undo availability checks.
    canUndo: true, canRedo: true,
    get config() { return state.config; }, get rawData() { return snapshot(); },
    scenes: [scene], recording: { durationMs: 10000, sessions: [], keystrokes: [], mouseEvents: [] },
    history: {
      update() { throw new Error('Use the model mutation methods, not a no-argument history update'); },
      historyBuffer: { flush() {} },
      get canUndo() { return undo.length > 0; }, get canRedo() { return redo.length > 0; },
      undo() { redo.push(snapshot()); Object.assign(state, undo.pop()); },
      redo() { undo.push(snapshot()); Object.assign(state, redo.pop()); },
    },
    updateConfig(patch) { commit(() => Object.assign(state.config, patch)); },
    markAsJustSaved() { this.isDirty = false; calls.push('saved'); },
  };
  return { project, scene, state, calls };
}
