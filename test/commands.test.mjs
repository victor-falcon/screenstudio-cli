import test from 'node:test';
import assert from 'node:assert/strict';
import { mockCDP, runCommand, projectFixture } from './helpers/cdp.mjs';

function setup(t, bridge = {}) {
  const fixture = projectFixture(), logs = [];
  t.mock.method(console, 'log', value => logs.push(value));
  const transport = mockCDP(t, {
    $project: fixture.project, $projects: new Map([['fixture', fixture.project]]),
    electronEnv: { APP_VERSION: '3.7.5-4595' },
    bridge: { client: { query: async () => ({}), mutation: async () => undefined, ...bridge } },
  });
  return { ...fixture, ...transport, logs };
}

test('bulk speed preserves independent audio settings and unknown slice data; undo restores both speeds', async t => {
  const { scene, calls } = setup(t);
  await runCommand('slice', ['speed', 'all', '4']);
  assert.deepEqual(scene.slices.map(s => s.speed), [4, 4]);
  assert.equal(scene.slices[0].volume, 0.7);
  assert.equal(scene.slices[0].systemAudioVolume, 0.8);
  assert.equal(scene.slices[0].externalDeviceAudioVolume, 0.9);
  assert.equal(scene.slices[0].data.futureField, 'keep');
  assert.equal(calls.length, 1);
  await runCommand('project', ['undo']);
  assert.deepEqual(scene.slices.map(s => s.speed), [1, 2]);
});

test('slice update treats zero volumes and cursor visibility independently', async t => {
  const { scene } = setup(t);
  await runCommand('slice', ['update', '0', '--system-volume', '0', '--device-volume', '0.2', '--hide-cursor', '--raw-cursor']);
  assert.equal(scene.slices[0].volume, 0.7);
  assert.equal(scene.slices[0].systemAudioVolume, 0);
  assert.equal(scene.slices[0].externalDeviceAudioVolume, 0.2);
  assert.equal(scene.slices[0].hideCursor, true);
  assert.equal(scene.slices[0].disableSmoothMouseMovement, true);
  assert.equal(scene.slices[1].systemAudioVolume, 1);
  await runCommand('slice', ['update', 'all', '--show-cursor', '--smooth-cursor']);
  assert.equal(scene.slices[0].hideCursor, false);
  assert.equal(scene.slices[0].disableSmoothMouseMovement, false);
});

test('invalid slice speed, index, and volume fail before mutation', async t => {
  const { calls } = setup(t);
  for (const args of [['speed', 'all', '0'], ['speed', 'all', 'NaN'], ['speed', '1.5', '2'],
    ['speed', '3', '2'], ['update', 'all', '--volume', '-1'], ['update', 'all', '--hide-cursor', '--show-cursor']]) {
    await assert.rejects(runCommand('slice', args));
  }
  assert.equal(calls.length, 0);
});

test('slice boundary commands reject malformed numbers and ambiguous removal requests before connecting', async t => {
  const { requests, calls } = setup(t);
  for (const [args, message] of [
    [['split', '1200oops'], /Split time must/],
    [['split', '--', '-1'], /Split time must/],
    [['remove', '0.5'], /Slice index must/],
    [['merge', '1oops'], /Slice index must/],
    [['trim', '0', '--start', 'NaN'], /Start time must/],
    [['trim', '0', '--end', 'Infinity'], /End time must/],
    [['remove', '--from', '1000'], /either a slice index or both/],
    [['remove', '0', '--from', '1000', '--to', '2000'], /either a slice index or both/],
    [['remove', '--from', '2000', '--to', '1000'], /End time must be greater/],
  ]) await assert.rejects(runCommand('slice', args), message);
  assert.equal(requests.length, 0);
  assert.equal(calls.length, 0);
});

test('invalid trims, out-of-recording removals, and merging the last slice fail without mutation', async t => {
  const { calls } = setup(t);
  for (const [args, message] of [
    [['trim', '0', '--start', '6000'], /End time must be greater/],
    [['trim', '0', '--end', '0'], /End time must be greater/],
    [['trim', '0', '--end', '10001'], /beyond the recording/],
    [['remove', '--from', '0', '--to', '10001'], /beyond the recording/],
    [['merge', '1'], /No next slice/],
  ]) await assert.rejects(runCommand('slice', args), message);
  assert.equal(calls.length, 0);
});

test('slice splitting preserves fractional source timestamps', async t => {
  const { scene } = setup(t);
  const received = [];
  scene.findSliceAtTime = time => {
    received.push(time);
    return { canSplitAt: () => true, splitAt: value => received.push(value) };
  };
  await runCommand('slice', ['split', '1200.5']);
  assert.deepEqual(received, [1200.5, 1200.5]);
});

test('adding an earlier highlight mask leaves the later mask untouched', async t => {
  const { scene } = setup(t);
  await runCommand('mask', ['add', '7000', '9000', '--x', '450', '--blur', '30']);
  const later = JSON.parse(JSON.stringify(scene.masks[0].data));
  await runCommand('mask', ['add', '0', '2000', '--type', 'highlight', '--opacity', '0.7', '--x', '20']);
  assert.equal(scene.masks[0].type, 'highlight');
  assert.equal(scene.masks[0].highlightMaskOpacity, 0.7);
  assert.equal(scene.masks[0].bounds[0].x, 20);
  assert.deepEqual(scene.masks[1].data, later);
});

test('mask updates preserve additional rectangles and accept explicit zeroes', async t => {
  const { scene } = setup(t);
  scene.addMask({ startTime: 1000, endTime: 4000, blur: 20, type: 'sensitive-data',
    bounds: [{ x: 50, y: 60, width: 70, height: 80 }, { x: 200, y: 0, width: 50, height: 50 }] });
  const id = scene.masks[0].id;
  await runCommand('mask', ['update', id, '--start', '0', '--blur', '0', '--x', '0', '--disable']);
  assert.equal(scene.masks[0].sourceStartTime, 0);
  assert.equal(scene.masks[0].blur, 0);
  assert.equal(scene.masks[0].isDisabled, true);
  assert.deepEqual(scene.masks[0].bounds, [
    { x: 0, y: 60, width: 70, height: 80 }, { x: 200, y: 0, width: 50, height: 50 },
  ]);
});

test('invalid mask ranges and unknown IDs do not mutate or claim success', async t => {
  const { calls } = setup(t);
  for (const args of [['add', '2000', '1000'], ['add', '0', '12000'], ['add', '0', '1000', '--width', '0'],
    ['update', "missing'quoted", '--blur', '10'], ['remove', 'missing']]) {
    await assert.rejects(runCommand('mask', args));
  }
  assert.equal(calls.length, 0);
});

test('instant and automatic zoom options survive updates and preserve other data', async t => {
  const { scene } = setup(t);
  await runCommand('zoom', ['add', '1000', '--end', '5000', '--id', 'zoom-1', '--instant', '--type', 'auto']);
  assert.equal(scene.zoomRanges[0].hasInstantAnimation, true);
  assert.equal(scene.zoomRanges[0].type, 'auto');
  await runCommand('zoom', ['update', 'zoom-1', '--start', '0', '--speed', '0', '--animated', '--x', '0']);
  assert.equal(scene.zoomRanges[0].hasInstantAnimation, false);
  assert.equal(scene.zoomRanges[0].glideSpeed, 0);
  assert.equal(scene.zoomRanges[0].sourceStartTime, 0);
  assert.deepEqual(scene.zoomRanges[0].manualTargetPoint, { x: 0, y: 0.5 });
  assert.equal(scene.zoomRanges[0].type, 'auto');
});

test('zoom rejects duplicate IDs and malformed replacement arrays', async t => {
  const { scene, calls } = setup(t);
  await runCommand('zoom', ['add', '0', '--id', 'one']);
  const count = calls.length;
  await assert.rejects(runCommand('zoom', ['add', '0', '--id', 'one']), /already exists/);
  await assert.rejects(runCommand('zoom', ['set', '{}']), /array/);
  await assert.rejects(runCommand('zoom', ['set', '[null]']), /object/);
  assert.equal(scene.zoomRanges.length, 1);
  assert.equal(calls.length, count);
});

test('config discovers runtime keys and rejects misspelled keys without creating them', async t => {
  const { project, calls, logs } = setup(t);
  project.config.futureFeature = true;
  await runCommand('config', ['--list']);
  assert.equal(JSON.parse(logs.at(-1)).futureFeature, true);
  await runCommand('config', ['microphoneInStereoMode', 'true']);
  assert.equal(project.config.microphoneInStereoMode, true);
  const count = calls.length;
  await assert.rejects(runCommand('config', ["missing'key", 'true']), /Unknown config key/);
  await assert.rejects(runCommand('config', ['audioVolume', 'NaN']), /Invalid value type/);
  await assert.rejects(runCommand('config', ['audioVolume', '1e999']), /must be finite/);
  await assert.rejects(runCommand('config', ['cursorSet', '{"variants":{"size":1e999}}']), /must be finite/);
  assert.equal(project.config.audioVolume, 1);
  assert.equal(calls.length, count);
});

test('background audio import waits for the asset copy; remove retains undo', async t => {
  const events = [];
  const { project } = setup(t, { mutation: async (route, input) => {
    assert.equal(route, 'project.copyFileToProject');
    assert.equal(input.sourcePath, '/tmp/music.mp3');
    await new Promise(resolve => setTimeout(resolve, 5));
    events.push('copied');
    return 'music.mp3';
  } });
  const update = project.updateConfig;
  project.updateConfig = patch => { events.push('configured'); update(patch); };
  await runCommand('audio', ['add', '/tmp/music.mp3', '--volume', '0']);
  assert.deepEqual(events, ['copied', 'configured']);
  assert.equal(project.config.backgroundAudioVolume, 0);
  assert.equal(project.config.backgroundAudioFileName, 'music.mp3');
  await runCommand('audio', ['remove']);
  assert.equal(project.config.backgroundAudioFileName, null);
  await runCommand('project', ['undo']);
  assert.equal(project.config.backgroundAudioFileName, 'music.mp3');
});

test('failed asset import leaves config unchanged', async t => {
  const { project, calls } = setup(t, { mutation: async () => { throw new Error('File missing'); } });
  await assert.rejects(runCommand('audio', ['add', '/tmp/missing.mp3']), /File missing/);
  assert.equal(project.config.backgroundAudioFileName, null);
  assert.equal(calls.length, 0);
});

test('save sends raw project data and marks saved only after IPC succeeds', async t => {
  const { project, calls } = setup(t, { mutation: async (route, input) => {
    assert.equal(route, 'project.updateProject');
    assert.equal(typeof input.data, 'object');
    assert.equal(input.projectPath, '/tmp/test.screenstudio');
    assert.equal(project.isDirty, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    calls.push('written');
  } });
  await runCommand('project', ['save']);
  assert.deepEqual(calls, ['written', 'saved']);
  assert.equal(project.isDirty, false);
});

test('save failure does not mark dirty state as saved', async t => {
  const { project } = setup(t, { mutation: async () => { throw new Error('Read-only volume'); } });
  await assert.rejects(runCommand('project', ['save']), /Read-only volume/);
  assert.equal(project.isDirty, true);
});

test('recording controls propagate native errors instead of printing success', async t => {
  const { logs } = setup(t, { mutation: async () => { throw new Error('No recording session'); } });
  for (const action of ['pause', 'resume', 'stop', 'cancel']) {
    await assert.rejects(runCommand('record', [action]), /No recording session/);
  }
  assert.equal(logs.length, 0);
});

test('undo checks the history availability, not the project placeholder', async t => {
  setup(t);
  await assert.rejects(runCommand('project', ['undo']), /Nothing to undo/);
  await assert.rejects(runCommand('project', ['redo']), /Nothing to redo/);
});

test('state includes all scenes, masks, camera layouts, and external device audio', async t => {
  const { project, scene, state, logs } = setup(t);
  state.scene.layouts.push({ id: 'layout-1', type: 'only-camera', startTime: 0, endTime: 5000 });
  scene.addMask({ type: 'highlight', startTime: 0, endTime: 1000, bounds: [] });
  project.scenes.push({ ...scene, id: 'scene-2', name: 'Second scene' });
  project.recording.hasExternalDeviceAudio = true;
  await runCommand('state', []);
  const result = JSON.parse(logs.at(-1));
  assert.equal(result.scenes.length, 2);
  assert.equal(result.scenes[0].masks[0].type, 'highlight');
  assert.equal(result.scenes[0].layouts[0].type, 'only-camera');
  assert.equal(result.scenes[0].slices[0].externalDeviceAudioVolume, 0.9);
  assert.equal(result.recording.hasExternalDeviceAudio, true);
});

test('status and doctor work without an active project; untested builds are identified', async t => {
  const { context, logs } = setup(t);
  context.$project = undefined;
  await runCommand('status', []);
  assert.equal(JSON.parse(logs.at(-1)).project, undefined);
  context.electronEnv.APP_VERSION = '4.0.0-beta';
  await runCommand('doctor', []);
  const report = JSON.parse(logs.at(-1));
  assert.equal(report.matchesAuditedVersion, false);
  assert.equal(report.checks.configEditing, null);
});

test('launch reuses an existing endpoint without invoking macOS app controls', async t => {
  const { logs } = setup(t);
  await runCommand('launch', []);
  assert.match(JSON.parse(logs.at(-1)).message, /Reusing/);
});

test('launch honors its local port override instead of the global default', async t => {
  const { logs } = setup(t);
  await runCommand('launch', ['--port', '9333']);
  assert.equal(JSON.parse(logs.at(-1)).port, 9333);
  assert.equal(globalThis.fetch.mock.calls[0].arguments[0], 'http://127.0.0.1:9333/json');
});

test('latest app speed preset 24x is accepted', async t => {
  const { scene } = setup(t);
  await runCommand('slice', ['speed', '0', '24']);
  assert.equal(scene.slices[0].speed, 24);
});

function exportSetup(t, manager, clipboardAction) {
  const fixture = setup(t);
  const current = { memoizedProps: { value: { project: fixture.project, exportManager: manager } },
    child: { memoizedProps: { parent: 'Export', action: { id: 'quickExportToClipboard' } },
      child: { memoizedProps: clipboardAction } } };
  // React's container fiber can be stale; the active tree is stateNode.current.
  fixture.context.document = { getElementById: () => ({
    __reactContainer$test: { stateNode: { current }, memoizedProps: {
      value: { project: {}, exportManager: { openPicker() { throw new Error('Wrong project'); } } },
    } },
  }) };
  return fixture;
}

test('export opens the active editor dialog and waits for native completion', async t => {
  const manager = { isPickerOpened: false, async openPicker() {
    await new Promise(resolve => setTimeout(resolve, 5));
    this.isPickerOpened = true;
  } };
  const { logs, requests } = exportSetup(t, manager);
  await runCommand('export', []);
  assert.equal(manager.isPickerOpened, true);
  assert.equal(JSON.parse(logs.at(-1)).message, 'Opened export dialog');
  assert.ok(requests.every(request => request.method !== 'Input.dispatchKeyEvent'));
});

test('export does not report success when the app leaves the dialog closed', async t => {
  const { logs } = exportSetup(t, { isPickerOpened: false, async openPicker() {} });
  await assert.rejects(runCommand('export', []), /did not open/);
  assert.equal(logs.length, 0);
});

test('clipboard export invokes the enabled native action and propagates failure', async t => {
  let calls = 0;
  const action = { enabled: true, async onClick() {
    await new Promise(resolve => setTimeout(resolve, 5)); calls++;
  } };
  const { logs } = exportSetup(t, {}, action);
  await runCommand('export', ['--clipboard']);
  assert.equal(calls, 1);
  action.onClick = async () => { throw new Error('Native export failed'); };
  await assert.rejects(runCommand('export', ['--clipboard']), /Native export failed/);
  action.enabled = false;
  await assert.rejects(runCommand('export', ['--clipboard']), /unavailable/);
  assert.equal(logs.length, 1);
});

test('export rejects missing project controls and exports already in progress', async t => {
  const manager = { isExportInProgress: true };
  const { context, logs } = exportSetup(t, manager);
  await assert.rejects(runCommand('export', []), /already in progress/);
  context.document.getElementById = () => null;
  await assert.rejects(runCommand('export', []), /Could not find/);
  context.$project = undefined;
  await assert.rejects(runCommand('export', []), /No project open/);
  assert.equal(logs.length, 0);
});

test('seek refreshes callbacks after reopening and ignores other project timelines', async t => {
  const { project, context } = setup(t);
  project.playbackDurationMs = 6000;
  const times = [], stale = () => { throw new Error('Stale or wrong project timeline'); };
  const oldOwner = { memoizedProps: { value: { project: {} } } };
  oldOwner.child = { memoizedProps: { onTimeClick: stale }, return: oldOwner };
  const owner = { memoizedProps: { value: { project } } };
  owner.child = { memoizedProps: { onTimeClick: time => times.push(time) }, return: owner };
  oldOwner.sibling = owner;
  context.document = { getElementById: () => ({ __reactContainer$test: {
    stateNode: { current: { child: oldOwner } }, child: oldOwner.child,
  } }) };
  context.__seekFn = context.__clickFn = stale;
  await runCommand('seek', ['1500.5']);
  const reopened = { playbackDurationMs: 6000 };
  owner.memoizedProps.value.project = context.$project = reopened;
  context.$projects = new Set([reopened]);
  owner.child.memoizedProps.onTimeClick = time => times.push(time + 1);
  await runCommand('seek', ['2500']);
  assert.deepEqual(times, [1500.5, 2501]);
});

test('seek and preview fail when no active timeline exists instead of reporting success', async t => {
  const { project, context, logs } = setup(t);
  project.playbackDurationMs = 6000;
  context.document = { getElementById: () => null };
  await assert.rejects(runCommand('seek', ['1000']), /Could not find the active project timeline/);
  await assert.rejects(runCommand('preview', ['--at', '1000']), /Could not find the active project timeline/);
  assert.equal(logs.length, 0);
});

test('closed project globals are ignored by status, doctor, reads, and editing commands', async t => {
  const { context, calls, logs } = setup(t);
  context.$projects.clear(); // $project remains set, just as in the live app.
  await runCommand('status', []);
  assert.equal(JSON.parse(logs.at(-1)).project, undefined);
  await runCommand('doctor', []);
  assert.equal(JSON.parse(logs.at(-1)).projectOpen, false);
  for (const [command, args] of [
    ['state', []], ['project', ['info']], ['project', ['save']], ['project', ['undo']],
    ['config', ['microphoneInStereoMode', 'true']], ['audio', ['remove']],
    ['slice', ['list']], ['slice', ['split', '1000']], ['slice', ['speed', 'all', '2']],
    ['mask', ['add', '0', '1000']], ['zoom', ['add', '0']],
    ['seek', ['1000']], ['preview', []], ['export', []],
  ]) await assert.rejects(runCommand(command, args), /No project open/);
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 2);
});

test('seek and preview reject invalid times and times beyond project duration', async t => {
  const { project, logs } = setup(t);
  project.playbackDurationMs = 6000;
  for (const time of ['NaN', 'Infinity', '6001']) {
    await assert.rejects(runCommand('seek', [time]));
    await assert.rejects(runCommand('preview', ['--at', time]));
  }
  assert.equal(logs.length, 0);
});
