// JavaScript prepended to every command evaluated in Screen Studio 4's main renderer.
// It defines `ss`, which resolves the app's private models from the few handles the app
// registers: `$projects` (open projects), `$$focused` (the focused editor), and the React
// tree (the action manager and the "Edit by transcript" controller). Method names are
// matched instead of minified class names, which change with every build.
export function runtimePrelude(projectSelector?: string): string {
  return `
var ss = (function () {
  var selector = ${JSON.stringify(projectSelector ?? null)};
  var sleep = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
  var round = function (n) { return typeof n === 'number' ? Math.round(n) : n; };
  var isEditor = function (v) {
    return !!v && typeof v === 'object' && !!v.exportManager && !!v.playback && !!v.view && !!v.project;
  };
  var isManager = function (v) {
    return !!v && typeof v === 'object' && !!v.defaultRunner && Array.isArray(v.actions) && !!v.targets;
  };

  function projects() {
    var set = window.$projects;
    if (!set || typeof set.values !== 'function') {
      throw new Error('Screen Studio did not expose its open projects. Run screenstudio doctor.');
    }
    return Array.from(set.values());
  }

  function describeProjects(list) {
    return list.map(function (p) { return '"' + p.name + '"'; }).join(', ');
  }

  function matchesSelector(p) {
    var base = String(p.path || '').replace(/\\/$/, '').split('/').pop();
    return p.path === selector || p.id === selector || p.name === selector ||
      base === selector || base === selector + '.screenstudio';
  }

  function project() {
    var open = projects();
    if (!open.length) throw new Error('No project open');
    if (selector) {
      var matches = open.filter(matchesSelector);
      if (!matches.length) throw new Error('No open project matches ' + selector + '. Open projects: ' + describeProjects(open));
      if (matches.length > 1) throw new Error('Several open projects match ' + selector + '. Pass the project path.');
      return matches[0];
    }
    if (open.length === 1) return open[0];
    var focused = window.$$focused;
    if (isEditor(focused) && open.indexOf(focused.project) >= 0) return focused.project;
    throw new Error('Several projects are open (' + describeProjects(open) + '). Pass --project <name or path>.');
  }

  function scene(p) {
    var s = (p || project()).scene;
    if (!s) throw new Error('No scene');
    return s;
  }

  function fiberKey(doc) {
    for (var el of doc.querySelectorAll('*')) {
      var key = Object.keys(el).find(function (k) { return k.startsWith('__reactFiber$'); });
      if (key) return key;
    }
    return null;
  }

  // Walks every fiber once, from each DOM node up to the root, and collects hook states
  // and context/model props that satisfy match.
  function scanFibers(doc, match) {
    var key = doc && fiberKey(doc);
    if (!key) return [];
    var seen = new Set(), found = new Set();
    var check = function (v) {
      try {
        if (match(v)) found.add(v);
        else if (Array.isArray(v) && match(v[0])) found.add(v[0]);
        else if (v && typeof v === 'object' && match(v.current)) found.add(v.current);
      } catch (e) { /* Ignore exotic values such as revoked proxies. */ }
    };
    for (var el of doc.querySelectorAll('*')) {
      for (var f = el[key]; f && !seen.has(f); f = f.return) {
        seen.add(f);
        for (var h = f.memoizedState, i = 0; h && typeof h === 'object' && i < 100; i++, h = h.next) check(h.memoizedState);
        var props = f.memoizedProps;
        if (props && typeof props === 'object') { check(props.value); check(props.model); }
      }
    }
    return Array.from(found);
  }

  var manager = null;
  function actionManager() {
    if (manager) return manager;
    var docs = [document];
    if (isEditor(window.$$focused)) docs.push(window.$$focused.view.document);
    for (var doc of docs) {
      var found = scanFibers(doc, isManager);
      if (found.length) return manager = found[0];
    }
    throw new Error("Could not find Screen Studio's action manager. Run screenstudio doctor.");
  }

  function editors() {
    var open = projects(), list = [];
    var add = function (v) { if (isEditor(v) && list.indexOf(v) < 0 && open.indexOf(v.project) >= 0) list.push(v); };
    add(window.$$focused);
    try { actionManager().targets.focusedTargets.forEach(function (t) { add(t.target); }); } catch (e) { /* $$focused is enough. */ }
    return list;
  }

  function editor(p) {
    p = p || project();
    var found = editors().find(function (e) { return e.project === p; });
    if (!found) throw new Error('The editor window of "' + p.name + '" is not open.');
    return found;
  }

  function action(id) {
    var found = actionManager().actions.find(function (a) { return a.id === id; });
    if (!found) throw new Error('Unknown Screen Studio action: ' + id + '. Run screenstudio action list.');
    return found;
  }

  function actionContext(target) {
    var runner = actionManager().defaultRunner;
    return target ? runner.createTargetContext(target) : runner.defaultContext;
  }

  async function runAction(id, target, input) {
    var a = action(id), context = actionContext(target);
    if (a.isInProgress) throw new Error('Action ' + id + ' is already running.');
    if (!a.canApply(context)) throw new Error('Action ' + id + ' does not apply right now.');
    await actionManager().defaultRunner.runWithContext(a, context, input);
  }

  // Pending edits are batched for 100ms before they become an undo step.
  function flush(p) {
    var buffer = (p || project()).history?.historyBuffer;
    if (buffer && typeof buffer.flush === 'function') buffer.flush();
  }

  // The "Edit by transcript" controller lives in its sidebar panel. Open the panel long
  // enough to get the controller, then restore the sidebar the user had open.
  async function transcriptEditor(ed, options) {
    ed = ed || editor();
    var isController = function (v) {
      return !!v && typeof v === 'object' && v.editor === ed &&
        typeof v.deleteTokens === 'function' && typeof v.cutTargetFromVideo === 'function';
    };
    var find = function () { return scanFibers(ed.view.document, isController)[0]; };
    var controller = find();
    if (!controller) {
      var view = ed.view, root = view.sidebarRoot, item = view.sidebarItem, hidden = view.shouldShowSidebar === false;
      if (hidden && typeof view.toggleSidebar === 'function') view.toggleSidebar();
      view.setSidebarRoot('transcript');
      try {
        for (var i = 0; i < 60 && !controller; i++) { await sleep(50); controller = find(); }
      } finally {
        if (root && root !== 'transcript') view.setSidebarRoot(root);
        if (item && typeof view.setSidebarItem === 'function') view.setSidebarItem(item);
        if (hidden && typeof view.toggleSidebar === 'function') view.toggleSidebar();
      }
    }
    if (!controller) throw new Error('Could not open the "Edit by transcript" panel in this Screen Studio build.');
    // The transcript loads asynchronously the first time a project's panel opens.
    for (var j = 0; j < 100 && !controller.isTranscriptReady && controller.client?.canGenerate && controller.client?.transcriptPromise; j++) {
      await sleep(50);
    }
    if (!controller.isTranscriptReady && !(options && options.allowMissing)) {
      throw new Error('This project has no transcript yet. Run screenstudio transcript generate.');
    }
    return controller;
  }

  function sliceInfo(s) {
    return {
      id: s.id, index: s.index,
      sourceStartMs: round(s.sourceStartMs), sourceEndMs: round(s.sourceEndMs),
      playbackStartMs: round(s.playbackStartMs), playbackEndMs: round(s.playbackEndMs),
      speed: s.speed, volume: s.volume, systemAudioVolume: s.systemAudioVolume,
      externalDeviceAudioVolume: s.externalDeviceAudioVolume, hideCursor: s.hideCursor,
      disableSmoothMouseMovement: s.disableSmoothMouseMovement,
    };
  }

  function itemInfo(item) {
    var data = item.serialize();
    return Object.assign({ index: item.index }, data, {
      sourceStartMs: round(data.sourceStartMs), sourceEndMs: round(data.sourceEndMs),
      playbackStartMs: round(item.playbackStartMs), playbackEndMs: round(item.playbackEndMs),
    });
  }

  function tokenInfo(controller, t) {
    var present = controller.getIsTokenPresent(t);
    var resolver = controller.project.scene.resolver;
    return {
      index: t.index, kind: t.kind, text: t.text,
      sourceStartMs: round(t.sourceStartMs), sourceEndMs: round(t.sourceEndMs),
      playbackStartMs: present ? round(resolver.sourceToPlaybackTime(t.sourceStartMs)) : null,
      present: present, hidden: !!t.isHidden, filler: t.fillerTier ?? null,
      sessionIndex: t.sessionIndex, wordIndex: t.wordIndex,
    };
  }

  return {
    sleep: sleep, round: round, projects: projects, project: project, scene: scene,
    scanFibers: scanFibers, actionManager: actionManager, editors: editors, editor: editor,
    action: action, actionContext: actionContext, runAction: runAction, flush: flush,
    transcriptEditor: transcriptEditor, sliceInfo: sliceInfo, itemInfo: itemInfo, tokenInfo: tokenInfo,
  };
})();
`;
}
