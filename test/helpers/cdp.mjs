import vm from 'node:vm';
import { Command } from 'commander';

const MAIN_URL = 'file:///Applications/Screen%20Studio.app/Contents/Resources/app.asar/dist/index.html';

export function mockCDP(t, globals = {}, options = {}) {
  const requests = [], sockets = [];
  const context = vm.createContext({ setTimeout, clearTimeout, Blob, btoa,
    electronEnv: { IS_RENDER_WORKER: false }, $projects: new Set(), ...globals });
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
      // The page finder's main-window probe is not a command request.
      const probe = request.method === 'Runtime.evaluate' && !('awaitPromise' in request.params);
      if (!probe && options.onRequest && options.onRequest(request, this) !== false) return;
      void (async () => {
        try {
          const target = options.contexts?.[this.url] ?? context;
          const value = request.method === 'Runtime.evaluate'
            ? await vm.runInContext(request.params.expression, target) : undefined;
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
    { type: 'page', url: MAIN_URL, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/test' },
  ])));
  const original = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  // Commands evaluate many small scripts; keep only the ones that ran command bodies.
  const evaluations = () => requests.filter(r => r.method === 'Runtime.evaluate' && r.params.awaitPromise);
  return { requests, sockets, context, evaluations };
}

let sequence = 0;
export async function runCommand(name, args, globalArgs = []) {
  const module = await import(`../../dist/cli/commands/${name}.js?test=${++sequence}`);
  const program = new Command().exitOverride().option('--json').option('--port <port>', 'CDP port', '9222')
    .option('--project <name-or-path>');
  program.addCommand(module[`${name}Command`]);
  const overrideExits = command => {
    command.exitOverride();
    command.commands.forEach(overrideExits);
  };
  overrideExits(program);
  await program.parseAsync(['--json', ...globalArgs, name, ...args], { from: 'user' });
}

// A fake DOM node whose React fiber holds `values` in its hook states.
export function fiberDocument(getValues) {
  return {
    querySelectorAll: () => getValues().map(value => ({
      '__reactFiber$test': { memoizedState: { memoizedState: value, next: null }, memoizedProps: {}, return: null },
    })),
  };
}

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// Small contract fixture for the Screen Studio 4.0.1 model shapes the CLI uses: timeline
// collections that refuse overlaps, a buffered undo history and the grouped config. It
// does not emulate rendering, IPC, or the app's MobX/Immer implementation.
export function projectFixture({ name = 'Fixture', path = '/tmp/test.screenstudio' } = {}) {
  let nextId = 1, pending = null;
  const calls = [], undo = [], redo = [];
  const state = {
    config: {
      captions: { enableTranscript: false, sizeRatio: 0.05, position01: { x: 0.5, y: 1 }, showSoundLabels: false },
      audio: { volume: 1, muteMicrophone: false, backgroundAudioFileName: null, backgroundAudioVolume: 0.1, clickSoundEffect: null },
      cursor: { hide: false, size: 1.5 },
    },
    slices: [
      { id: 's1', sourceStartMs: 0, sourceEndMs: 5000, timeScale: 1, volume: 0.7, systemAudioVolume: 0.8,
        externalDeviceAudioVolume: 0.9, hideCursor: false, disableSmoothMouseMovement: false, futureField: 'keep' },
      { id: 's2', sourceStartMs: 5000, sourceEndMs: 10000, timeScale: 0.5, volume: 1, systemAudioVolume: 1,
        externalDeviceAudioVolume: 1, hideCursor: false, disableSmoothMouseMovement: false },
    ],
    zooms: [], masks: [], layouts: [], voiceOvers: [],
  };
  const snapshot = () => clone(state);
  const restore = saved => { for (const key of Object.keys(state)) state[key] = saved[key]; };
  function commit(fn) {
    pending ??= snapshot();
    fn();
    calls.push('update');
    project.isDirty = true;
  }
  const history = {
    historyBuffer: { flush() { if (pending) { undo.push(pending); redo.length = 0; pending = null; } } },
    get canUndo() { return undo.length > 0; },
    get canRedo() { return redo.length > 0; },
    undo() { this.historyBuffer.flush(); if (!undo.length) return; redo.push(snapshot()); restore(undo.pop()); },
    redo() { this.historyBuffer.flush(); if (!redo.length) return; undo.push(snapshot()); restore(redo.pop()); },
  };

  const defaults = {
    zooms: { zoom: 2, type: 'manual', presentation: 'screen', isDisabled: false, hasInstantAnimation: false,
      manualTargetPoint: { x: 0.5, y: 0.5 }, loupeOptions: { radius01: 0.35, bevelRatio: 0.2, chromaticAberration: 0.5, hasGlassOptics: true } },
    masks: { isDisabled: false, bounds: [{ x: 100, y: 100, width: 350, height: 80 }], blur: 32, type: 'sensitive-data', highlightMaskOpacity: 0.5 },
    layouts: { type: 'camera-overlay', isDisabled: false },
    slices: {}, voiceOvers: {},
  };

  class Item {
    constructor(collection, id) { this.collection = collection; this.id = id; }
    get data() { return state[this.collection.key].find(d => d.id === this.id); }
    get sourceStartMs() { return this.data.sourceStartMs; }
    get sourceEndMs() { return this.data.sourceEndMs; }
    get index() { return this.collection.all.indexOf(this); }
    get previous() { return this.collection.all[this.index - 1] ?? null; }
    get next() { return this.collection.all[this.index + 1] ?? null; }
    get playbackStartMs() { return this.sourceStartMs; }
    get playbackEndMs() { return this.sourceEndMs; }
    serialize() { return clone(this.data); }
    update(changes) { commit(() => { Object.assign(this.data, clone(changes)); this.collection.sort(); }); }
    remove() { commit(() => { state[this.collection.key] = state[this.collection.key].filter(d => d.id !== this.id); }); return true; }
  }
  class Slice extends Item {
    get timeScale() { return this.data.timeScale; }
    get speed() { return 1 / this.data.timeScale; }
    get volume() { return this.data.volume; }
    get systemAudioVolume() { return this.data.systemAudioVolume; }
    get externalDeviceAudioVolume() { return this.data.externalDeviceAudioVolume; }
    get hideCursor() { return this.data.hideCursor; }
    get disableSmoothMouseMovement() { return this.data.disableSmoothMouseMovement; }
    get playbackStartMs() { return this.collection.all.slice(0, this.index).reduce((sum, s) => sum + s.playbackDuration, 0); }
    get playbackDuration() { return (this.sourceEndMs - this.sourceStartMs) * this.timeScale; }
    get playbackEndMs() { return this.playbackStartMs + this.playbackDuration; }
    remove() { return state.slices.length > 1 && super.remove(); }
    mergeWithNext() { const next = this.next; commit(() => { this.data.sourceEndMs = next.sourceEndMs; state.slices = state.slices.filter(d => d.id !== next.id); }); }
  }
  class Zoom extends Item {
    get zoom() { return this.data.zoom; }
    get type() { return this.data.type; }
    get presentation() { return this.data.presentation; }
    get loupeOptions() { return this.data.loupeOptions; }
    get manualTargetPoint() { return this.data.manualTargetPoint; }
    get isDisabled() { return this.data.isDisabled; }
    get isLoupe() { return this.data.presentation === 'loupe'; }
  }
  class Mask extends Item {
    get bounds() { return this.data.bounds; }
    get type() { return this.data.type; }
    get isDisabled() { return this.data.isDisabled; }
  }
  class Layout extends Item {
    get type() { return this.data.type; }
    changeType(type) { commit(() => { this.data.type = type; }); }
  }
  class Collection {
    minItemDurationMs = 100;
    items = new Map();
    constructor(key, ItemClass) { this.key = key; this.ItemClass = ItemClass; }
    get all() {
      return state[this.key].map(d => {
        if (!this.items.has(d.id)) this.items.set(d.id, new this.ItemClass(this, d.id));
        return this.items.get(d.id);
      });
    }
    sort() { state[this.key].sort((a, b) => a.sourceStartMs - b.sourceStartMs); }
    get length() { return state[this.key].length; }
    at(i) { return this.all[i] ?? null; }
    get(id) { return this.all.find(item => item.id === id) ?? null; }
    map(fn) { return this.all.map(fn); }
    filter(fn) { return this.all.filter(fn); }
    forEach(fn) { this.all.forEach(fn); }
    some(fn) { return this.all.some(fn); }
    every(fn) { return this.all.every(fn); }
    find(fn) { return this.all.find(fn); }
    findAt(ms) { return this.all.find(i => i.sourceStartMs <= ms && i.sourceEndMs > ms) ?? null; }
    findNextAt(ms) { return this.all.find(i => i.sourceStartMs >= ms) ?? null; }
    canSplitAt(ms) { const i = this.findAt(ms); return !!i && ms - i.sourceStartMs >= this.minItemDurationMs && i.sourceEndMs - ms >= this.minItemDurationMs; }
    splitAt(ms) {
      if (!this.canSplitAt(ms)) return false;
      const item = this.findAt(ms);
      commit(() => {
        const right = { ...clone(item.data), id: `split-${nextId++}`, sourceStartMs: ms };
        item.data.sourceEndMs = ms;
        state[this.key].push(right);
        this.sort();
      });
      return true;
    }
    add(input) {
      if (this.findAt(input.sourceStartMs)) return null;
      const next = this.all.find(i => i.sourceStartMs > input.sourceStartMs);
      const data = { ...clone(defaults[this.key]), ...clone(input), id: `${this.key}-${nextId++}` };
      if (next) data.sourceEndMs = Math.min(data.sourceEndMs, next.sourceStartMs);
      commit(() => { state[this.key].push(data); this.sort(); });
      return this.get(data.id);
    }
    removeAll() { commit(() => { state[this.key] = []; }); }
  }

  const scene = {
    id: 'scene-1', name: 'Default', type: 'recording',
    slices: new Collection('slices', Slice), zooms: new Collection('zooms', Zoom), masks: new Collection('masks', Mask),
    layouts: new Collection('layouts', Layout), voiceOvers: new Collection('voiceOvers', Item),
    resolver: {
      sourceToPlaybackTime: ms => ms,
      getIsSourceTimePresent: ms => !!scene.slices.findAt(ms),
      getIsSourceRangePresent: ([a, b]) => scene.slices.all.some(s => s.sourceStartMs <= a && s.sourceEndMs >= b),
    },
  };
  const project = {
    id: `project-${name}`, name, path, isDirty: false,
    scenes: [scene], scene, history,
    get playbackDurationMs() { return scene.slices.all.reduce((sum, s) => sum + s.playbackDuration, 0); },
    get sourceDurationMs() { return 10000; },
    recording: { durationMs: 10000, hasMicrophone: true, hasCamera: true, sessions: [], keystrokes: [], mouseEvents: [] },
    projectConfig: { serialize: () => clone(state.config) },
    get captionsConfig() { return state.config.captions; },
    updateConfig(patch) {
      calls.push('updateConfig');
      commit(() => { for (const [group, values] of Object.entries(clone(patch))) Object.assign(state.config[group], values); });
    },
    serialize() { return { id: this.id, name, config: clone(state.config) }; },
  };
  return { project, scene, state, calls };
}

// A recording stand-in for the "Edit by transcript" controller. Its tokens are the
// runtime's token shapes; actions are recorded instead of editing the timeline.
export function transcriptController(editor, words) {
  const actions = [];
  let index = 0;
  const tokens = words.map(([text, present = true, kind = 'word']) => {
    const start = index * 500;
    return { id: `${kind}:${index}`, index: index++, kind, text, sourceStartMs: start, sourceEndMs: start + 400,
      fillerTier: null, isHidden: false, sessionIndex: 0, sessionOffsetMs: 0, wordIndex: kind === 'word' ? index - 1 : null, present };
  });
  const controller = {
    editor, actions, tokens,
    get project() { return editor.project; },
    isTranscriptReady: true, isVerbatimTranscript: true, selection: null,
    client: { canGenerate: true, currentGenerator: { type: 'whisper', language: 'auto', model: 'small' }, transcript: [],
      generate: async generator => { actions.push(['generate', generator]); return true; } },
    get paragraphs() { return [{ tokens }]; },
    get presentFillerTokens() { return []; },
    get tightenablePauseTokens() { return []; },
    getIsTokenPresent: t => t.present,
    deleteTokens: list => { actions.push(['delete', Array.from(list, t => t.index)]); return Array.from(list).some(t => t.present); },
    cutTargetFromVideo() {},
    setCoveredWordsHidden: (list, hidden) => actions.push(['hidden', Array.from(list, t => t.index), hidden]),
    applyWordRangeReplacement: (token, text) => actions.push(['replace', token.index, text]),
    setSelection(selection) { this.selection = selection; },
    clearSelection() { this.selection = null; },
    replaceCoveredWordsWithText(text) {
      actions.push(['replaceRange', this.selection.anchor.tokenIndex, this.selection.focus.tokenIndex, text]);
      return 'handled';
    },
    get canRestoreTarget() { return true; },
    restoreTarget() { actions.push(['restore', this.selection.anchor.tokenIndex, this.selection.focus.tokenIndex]); },
    removeAllFillerWords() {}, tightenAllPauses() {},
  };
  return controller;
}

// Wires one or more fixtures into the globals Screen Studio 4 exposes to the main window.
export function appFixture(projects = [projectFixture()], { focused = 0 } = {}) {
  const ran = [];
  const editors = projects.map(({ project }) => {
    const editor = {
      project,
      playback: { headTime: 0, headSourceTime: 0, goTo(ms) { this.headTime = ms; this.headSourceTime = ms; }, goToSourceTime(ms) { this.goTo(ms); }, pause() {} },
      animation: { waitForFrameReady: async () => {}, exportImage: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) },
      exportManager: { isExportInProgress: false, isPickerOpened: false, exportProgress: null,
        startExport: async config => { ran.push(['startExport', config]); return 'export-1'; },
        openPicker: async function () { this.isPickerOpened = true; } },
      transcript: null,
      view: {
        sidebarRoot: 'background', sidebarItem: null, shouldShowSidebar: true,
        setSidebarRoot(root) { this.sidebarRoot = root; },
        setSidebarItem(item) { this.sidebarItem = item; },
      },
    };
    // The controller exists only while the transcript panel is mounted.
    editor.view.document = fiberDocument(() => editor.view.sidebarRoot === 'transcript' && editor.transcript ? [editor.transcript] : []);
    return editor;
  });
  const action = (id, target = 'Editor') => ({
    id, isInProgress: false, targetTypeDescription: { name: target }, defaultShortcut: null,
    canApply: context => target === 'Editor' ? context.targets.some(t => t.exportManager) : context.targets.some(t => !t.exportManager),
    run: async (context, input) => ran.push([id, context.targets[0], input]),
  });
  const manager = {
    actions: [action('saveProject'), action('toggleZoomLoupeMode', 'Zoom')],
    targets: { focusedTargets: editors.map(target => ({ target })) },
    defaultRunner: {
      createTargetContext: target => ({ targets: [target] }),
      get defaultContext() { return { targets: [editors[focused]] }; },
      runWithContext: async (a, context, input) => a.run(context, input),
    },
  };
  const globals = {
    electronEnv: { APP_VERSION: '4.0.1-4897', IS_RENDER_WORKER: false },
    $projects: new Set(projects.map(p => p.project)),
    $$focused: editors[focused],
    document: fiberDocument(() => [manager]),
    localStorage: new Map(),
    bridge: { client: { query: async () => ({}), mutation: async (...args) => { ran.push(['mutation', ...args]); } } },
  };
  globals.localStorage.getItem = globals.localStorage.get;
  return { globals, editors, manager, ran };
}
