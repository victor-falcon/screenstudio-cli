import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECORDING_VIDEO } from '../dist/cli/recording.js';
import { mockCDP, projectFixture, runCommand } from './helpers/cdp.mjs';

test('uses session metadata for window, device, and imported video filenames', () => {
  for (const path of ['/tmp/channel-8-window-0.mp4', '/tmp/channel-2-external-device-0.mp4', "/tmp/imported 'demo'.mov"]) {
    const result = vm.runInNewContext(`(function() { ${RECORDING_VIDEO} return videoPath; })()`, {
      p: { recording: { sessions: [{ recordingVideoPath: path }] } },
    });
    assert.equal(result, path);
  }
});

test('refuses to silently extract the wrong session after recording pause/resume', () => {
  assert.throws(() => vm.runInNewContext(`(function() { ${RECORDING_VIDEO} })()`, {
    p: { recording: { sessions: [{}, {}] } },
  }), /Use screenstudio preview/);
});

let hasFFmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
} catch { hasFFmpeg = false; }

test('real ffmpeg extraction handles fractional intervals and literal special characters in paths', { skip: !hasFFmpeg }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'screenstudio-cli-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const videoPath = join(directory, "window recording 'demo' $(literal).mp4");
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'color=c=red:s=64x48:r=10:d=2', '-c:v', 'mpeg4', '-y', videoPath], { stdio: 'ignore' });
  const { project, state } = projectFixture();
  Object.assign(project.recording, { recordingPath: directory, durationMs: 2000, sessions: [{ recordingVideoPath: videoPath }] });
  state.scene.slices = [{ id: 'one', sourceStartMs: 0, sourceEndMs: 2000, timeScale: 1, volume: 1 }];
  const logs = [];
  t.mock.method(console, 'log', value => logs.push(value));
  mockCDP(t, { $project: project });
  const analyzeDir = join(directory, "analyze 'frames' $(literal)"), renderDir = join(directory, 'render frames');
  mkdirSync(analyzeDir); mkdirSync(renderDir);
  await runCommand('analyze', ['--interval', '0.5', '--output', analyzeDir]);
  const analysis = JSON.parse(logs.at(-1));
  assert.equal(analysis.frames.length, 4);
  assert.deepEqual(analysis.frames.map(f => f.timeMs), [0, 500, 1000, 1500]);
  await runCommand('render', ['--fps', '2', '--output', renderDir]);
  const render = JSON.parse(logs.at(-1));
  assert.equal(render.totalFrames, 4);
  assert.equal(readdirSync(renderDir).filter(name => name.endsWith('.jpg')).length, 4);

  // Zoom boundaries rarely align with the output FPS. Counting rounded-up
  // estimates produces missing frame numbers between ffmpeg invocations.
  state.scene.zoomRanges = [{ id: 'zoom', type: 'manual', zoom: 2, startTime: 700, endTime: 1100,
    manualTargetPoint: { x: 0.5, y: 0.5 }, isDisabled: false }];
  const segmentedDir = join(directory, 'segmented frames');
  await runCommand('render', ['--fps', '2', '--output', segmentedDir]);
  const segmented = JSON.parse(logs.at(-1));
  const files = readdirSync(segmentedDir).filter(name => name.endsWith('.jpg')).sort();
  assert.equal(segmented.totalFrames, files.length);
  assert.deepEqual(files, files.map((_, index) => `frame_${String(index + 1).padStart(4, '0')}.jpg`));
});
