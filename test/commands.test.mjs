import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appFixture, mockCDP, projectFixture, runCommand, transcriptController } from './helpers/cdp.mjs';

function setup(t, projects, options) {
  const app = appFixture(projects, options), logs = [];
  t.mock.method(console, 'log', value => logs.push(value));
  const transport = mockCDP(t, app.globals);
  const last = () => JSON.parse(logs.at(-1));
  return { ...app, ...transport, logs, last };
}

test('bulk speed changes become one undo step that restores every slice', async t => {
  const fixture = projectFixture();
  setup(t, [fixture]);
  await runCommand('slice', ['speed', 'all', '4']);
  assert.deepEqual(fixture.scene.slices.map(s => s.speed), [4, 4]);
  assert.equal(fixture.state.slices[0].futureField, 'keep');
  await runCommand('project', ['undo']);
  assert.deepEqual(fixture.scene.slices.map(s => s.speed), [1, 2]);
  assert.equal(fixture.project.history.canUndo, false);
});

test('slice update changes only the requested channels and cursor settings', async t => {
  const fixture = projectFixture();
  setup(t, [fixture]);
  await runCommand('slice', ['update', '0', '--system-volume', '0', '--device-volume', '0.2', '--hide-cursor', '--raw-cursor']);
  const [first, second] = fixture.state.slices;
  assert.deepEqual([first.volume, first.systemAudioVolume, first.externalDeviceAudioVolume, first.hideCursor, first.disableSmoothMouseMovement], [0.7, 0, 0.2, true, true]);
  assert.equal(second.systemAudioVolume, 1);
});

test('removing a source range inside a slice splits it and trims the right part', async t => {
  const fixture = projectFixture();
  const { last } = setup(t, [fixture]);
  await runCommand('slice', ['remove', '--from', '1000', '--to', '2000']);
  assert.deepEqual(fixture.state.slices.map(s => [s.sourceStartMs, s.sourceEndMs]), [[0, 1000], [2000, 5000], [5000, 10000]]);
  assert.equal(last().removedMs, 1000);
  await runCommand('slice', ['remove', '--from', '4950', '--to', '6000']);
  // The 50ms left of the second slice is shorter than a slice can be, so it is dropped.
  assert.deepEqual(fixture.state.slices.map(s => [s.sourceStartMs, s.sourceEndMs]), [[0, 1000], [2000, 4950], [6000, 10000]]);
  await assert.rejects(runCommand('slice', ['remove', '--from', '0', '--to', '10000']), /entire video/);
});

test('slice commands validate input before connecting', async t => {
  const { requests } = setup(t, [projectFixture()]);
  for (const [args, message] of [
    [['split', '1200oops'], /Split time must/],
    [['remove', '0.5'], /Slice index must/],
    [['speed', 'all', '0'], /Speed must/],
    [['update', 'all', '--volume', '-1'], /volume must/],
    [['remove', '--from', '1000'], /either a slice index or both/],
    [['remove', '--from', '2000', '--to', '1000'], /End time must be greater/],
  ]) await assert.rejects(runCommand('slice', args), message);
  assert.equal(requests.length, 0);
});

test('trims and merges respect neighbours and the recording', async t => {
  const fixture = projectFixture();
  setup(t, [fixture]);
  await assert.rejects(runCommand('slice', ['trim', '0', '--end', '6000']), /overlaps the next slice/);
  await assert.rejects(runCommand('slice', ['trim', '1', '--end', '10001']), /beyond the recording/);
  await assert.rejects(runCommand('slice', ['merge', '1']), /No next slice/);
  await runCommand('slice', ['merge', '0']);
  assert.deepEqual(fixture.state.slices.map(s => s.id), ['s1']);
  await assert.rejects(runCommand('slice', ['remove', '0']), /only slice/);
});

test('loupe zooms merge partial lens options into the defaults and refuse overlaps', async t => {
  const fixture = projectFixture();
  const { last } = setup(t, [fixture]);
  await runCommand('zoom', ['add', '1000', '--end', '3000', '--loupe', '--radius', '0.5', '--type', 'auto']);
  const zoom = fixture.state.zooms[0];
  assert.equal(zoom.presentation, 'loupe');
  assert.equal(zoom.type, 'follow-mouse');
  assert.deepEqual(zoom.loupeOptions, { radius01: 0.5, bevelRatio: 0.2, chromaticAberration: 0.5, hasGlassOptics: true });
  assert.equal(last().id, zoom.id);
  await assert.rejects(runCommand('zoom', ['add', '2000']), /cannot overlap/);
  await runCommand('zoom', ['update', zoom.id, '--screen', '--x', '0.2']);
  assert.equal(fixture.state.zooms[0].presentation, 'screen');
  assert.deepEqual(fixture.state.zooms[0].manualTargetPoint, { x: 0.2, y: 0.5 });
  await assert.rejects(runCommand('zoom', ['set', '[{"sourceStartMs":0,"sourceEndMs":1,"zoom":2,"type":"spiral"}]']), /Zoom type must be/);
});

test('masks and layouts are created in free ranges and keep extra mask rectangles', async t => {
  const fixture = projectFixture();
  setup(t, [fixture]);
  await runCommand('mask', ['add', '1000', '2000', '--type', 'highlight', '--width', '500']);
  const mask = fixture.state.masks[0];
  assert.deepEqual(mask.bounds, [{ x: 100, y: 100, width: 500, height: 80 }]);
  mask.bounds.push({ x: 1, y: 2, width: 3, height: 4 });
  await runCommand('mask', ['update', mask.id, '--height', '300', '--disable']);
  assert.deepEqual(fixture.state.masks[0].bounds, [{ x: 100, y: 100, width: 500, height: 300 }, { x: 1, y: 2, width: 3, height: 4 }]);
  assert.equal(fixture.state.masks[0].isDisabled, true);
  await runCommand('layout', ['add', '3000', '4000', '--type', 'split-screen']);
  assert.equal(fixture.state.layouts[0].type, 'split-screen');
});

test('config writes nested paths as one partial group update and explains old flat keys', async t => {
  const fixture = projectFixture();
  const { last } = setup(t, [fixture]);
  await runCommand('config', ['captions.position01.y', '0.9']);
  assert.deepEqual(fixture.state.config.captions.position01, { x: 0.5, y: 0.9 });
  assert.deepEqual(last(), { key: 'captions.position01.y', value: 0.9 });
  assert.equal(fixture.calls.filter(c => c === 'updateConfig').length, 1);
  await assert.rejects(runCommand('config', ['clickSoundEffect', 'null']), /Did you mean audio\.clickSoundEffect/);
  await assert.rejects(runCommand('config', ['showTranscript']), /Did you mean captions\.enableTranscript/);
  await assert.rejects(runCommand('config', ['audio.volume', '"loud"']), /expected number/);
  await assert.rejects(runCommand('config', ['audio.__proto__', '1']), /Unknown config key/);
  await runCommand('config', ['audio.volume']);
  assert.equal(last(), 1);
});

test('save runs the app save action against the project editor', async t => {
  const fixture = projectFixture();
  const { ran, editors } = setup(t, [fixture]);
  await runCommand('project', ['save']);
  assert.equal(ran[0][0], 'saveProject');
  assert.equal(ran[0][1], editors[0]);
});

test('commands pick the focused project, or the one --project names', async t => {
  const one = projectFixture({ name: 'One', path: '/tmp/one.screenstudio' });
  const two = projectFixture({ name: 'Two', path: '/tmp/two.screenstudio' });
  const { last, context } = setup(t, [one, two], { focused: 1 });
  await runCommand('project', ['info']);
  assert.equal(last().name, 'Two');
  await runCommand('project', ['info'], ['--project', 'one']);
  assert.equal(last().name, 'One');
  await assert.rejects(runCommand('project', ['info'], ['--project', 'three']), /No open project matches three/);
  context.$$focused = null;
  await assert.rejects(runCommand('project', ['info']), /Several projects are open/);
});

test('transcript commands open the panel for its controller and restore the sidebar', async t => {
  const fixture = projectFixture();
  const { editors, last } = setup(t, [fixture]);
  const controller = transcriptController(editors[0], [['Hola'], ['a'], ['todos.'], ['Y'], ['adiós.']]);
  editors[0].transcript = controller;
  await runCommand('transcript', ['cut', '--text', 'a todos']);
  assert.deepEqual(controller.actions, [['delete', [1, 2]]]);
  assert.equal(editors[0].view.sidebarRoot, 'background');
  assert.equal(last().text, 'a todos.');
  await assert.rejects(runCommand('transcript', ['cut', '9']), /out of range/);
  await runCommand('transcript', ['hide', '0-1']);
  assert.deepEqual(controller.actions.at(-1), ['hidden', [0, 1], true]);
  await runCommand('transcript', ['fix', '3-4', 'Y', 'chao.']);
  assert.deepEqual(controller.actions.at(-1), ['replaceRange', 3, 4, 'Y chao.']);
});

test('transcript apply cuts deleted words and corrects retyped ones in a single pass', async t => {
  const fixture = projectFixture();
  const { editors, last } = setup(t, [fixture]);
  const controller = transcriptController(editors[0], [['Hola'], [''], ['a'], ['todos.'], ['Esto'], ['sobra.'], ['Lab'], ['Bench'], ['fin.']]);
  editors[0].transcript = controller;
  const dir = mkdtempSync(join(tmpdir(), 'screenstudio-apply-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await runCommand('transcript', ['text', '--output', join(dir, 'transcript.txt')]);
  const text = readFileSync(join(dir, 'transcript.txt'), 'utf8');
  assert.match(text, /^Hola a todos\. Esto sobra\. Lab Bench fin\.$/m);
  writeFileSync(join(dir, 'edited.txt'), text.replace('Esto sobra. ', '').replace('Lab Bench', 'LabBench'));
  await runCommand('transcript', ['apply', join(dir, 'edited.txt')]);
  assert.deepEqual(controller.actions, [['delete', [4, 5]], ['replaceRange', 6, 7, 'LabBench']]);
  assert.equal(last().cuts.length, 1);

  // A transcript that changes between reading and editing is not edited with stale indexes.
  const { tokens } = controller, grown = [...tokens, { ...tokens[0], index: tokens.length }];
  let reads = 0;
  Object.defineProperty(controller, 'tokens', { get: () => (reads++ ? grown : tokens) });
  controller.actions.length = 0;
  await assert.rejects(runCommand('transcript', ['apply', join(dir, 'edited.txt')]), /transcript changed/);
  assert.deepEqual(controller.actions, []);
});

test('export merges stored settings with options and validates them for the format', async t => {
  const fixture = projectFixture();
  const { ran, globals, last } = setup(t, [fixture]);
  globals.localStorage.set('export-settings-preference-mp4-export-settings', JSON.stringify({ json: { format: 'mp4', fps: 60, quality: 'studio', height: 2160 } }));
  await runCommand('export', ['--resolution', '1080']);
  const [, config] = ran.find(r => r[0] === 'startExport');
  assert.deepEqual([config.format, config.fps, config.quality, config.height, config.target, config.projectPath], ['mp4', 60, 'studio', 1080, 'file', fixture.project.path]);
  assert.equal(last().target, 'file');
  await assert.rejects(runCommand('export', ['--format', 'gif', '--fps', '60']), /Invalid gif fps: 60/);
});

test('actions run against the editor, or against a zoom with --zoom', async t => {
  const fixture = projectFixture();
  fixture.state.zooms.push({ id: 'z1', sourceStartMs: 0, sourceEndMs: 1000, zoom: 2, type: 'manual', presentation: 'screen' });
  const { ran } = setup(t, [fixture]);
  await runCommand('action', ['run', 'toggleZoomLoupeMode', '--zoom', 'z1']);
  assert.equal(ran[0][0], 'toggleZoomLoupeMode');
  assert.equal(ran[0][1].id, 'z1');
  await assert.rejects(runCommand('action', ['run', 'toggleZoomLoupeMode']), /does not apply/);
  await assert.rejects(runCommand('action', ['run', 'nope']), /Unknown Screen Studio action/);
});

test('seek moves the editor playhead and preview writes the rendered frame', async t => {
  const fixture = projectFixture();
  const { editors, last } = setup(t, [fixture]);
  await runCommand('seek', ['2500']);
  assert.equal(editors[0].playback.headTime, 2500);
  await assert.rejects(runCommand('seek', ['20000']), /outside the project/);
  const dir = mkdtempSync(join(tmpdir(), 'screenstudio-preview-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await runCommand('preview', ['--at', '1000', '--output', join(dir, 'frame.png')]);
  assert.deepEqual([...readFileSync(join(dir, 'frame.png'))], [137, 80, 78, 71]);
  assert.equal(last().playbackMs, 1000);
});
