/** Run the suite with the color environment that a terminal-backed test runner injects.
 *
 * `node --test` exports `FORCE_COLOR=1` to every test file when its own stdout is a TTY, so a suite
 * started from a terminal observes a different environment than the same suite started over a pipe.
 * Ink then styles each frame through chalk, and an escape sequence lands between a prompt and its
 * text. Running the suite here reproduces that environment on any host, including CI and Windows.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const npm = process.env.npm_execpath;
assert(npm, 'Run this check with npm run test:terminal');
const child = spawn(process.execPath, [npm, 'test'], {
  stdio: 'inherit',
  env: { ...process.env, FORCE_COLOR: '1' },
});
const [code, signal] = await new Promise(resolve => {
  child.on('close', (code, signal) => resolve([code, signal]));
});
assert.equal(signal, null, `Suite was killed by ${signal}`);
assert.equal(code, 0, 'Suite failed under the color environment a terminal injects');
console.log('Suite passed with FORCE_COLOR=1.');
