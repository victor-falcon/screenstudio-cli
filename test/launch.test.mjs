import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mockCDP, runCommand } from './helpers/cdp.mjs';

test('explicit restart quits and relaunches even when the existing CDP endpoint works', async t => {
  mockCDP(t);
  const commands = [], logs = [];
  t.mock.method(console, 'log', value => logs.push(value));
  const original = childProcess.execFileSync;
  childProcess.execFileSync = (file, args) => {
    commands.push([file, args]);
    return file === 'osascript' && args[1].endsWith('is running') ? 'true\n' : '';
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });

  await runCommand('launch', ['--restart', '--port', '9333']);
  // Builds that share the "Screen Studio" name are told apart by bundle identifier.
  assert.deepEqual(commands, [
    ['osascript', ['-e', 'application id "com.timpler.screenstudio" is running']],
    ['osascript', ['-e', 'quit app id "com.timpler.screenstudio"']],
    ['open', ['-b', 'com.timpler.screenstudio', '--args', '--remote-debugging-port=9333']],
  ]);
  assert.equal(JSON.parse(logs.at(-1)).message, 'Screen Studio debugging connection ready');
});
