/** Pin the render-measurement behavior the executable entry depends on.
 *
 * `src/cli/index.ts` selects React's production build precisely because the development build
 * appends one `performance.measure()` entry per rendered component to Node's global performance
 * timeline, which retains a props payload per entry for the life of the process. These probes run
 * the real Ink binding in a child process so the assertion covers the build React actually loads,
 * not just the entry's own logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

/** Enough renders for the development build to append hundreds of measures, which keeps the probe
 * decisive without paying for a large render loop in the default suite. */
const RENDERS = 40;

/** Run the render probe in a fresh process with an explicit React build selection.
 * @param reactDev - When true the development build is requested, otherwise the production one.
 * @returns Measure entry count the probe reported, or a message describing its failure.
 */
async function probe(reactDev: boolean): Promise<{ measures?: number; error?: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/perf-probe.ts'], {
    cwd: new URL('../..', import.meta.url),
    env: {
      PATH: process.env.PATH,
      PERF_PROBE_RENDERS: String(RENDERS),
      ...(reactDev ? { DSHT_REACT_DEV: '1' } : { NODE_ENV: 'production' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) return { error: `probe exited with ${code}: ${stderr.slice(-500)}` };
    const match = /^PERF_PROBE_MEASURES=(\d+)$/m.exec(stdout);
    if (match === null) return { error: `probe reported no measure count: ${stdout.slice(-300)}` };
    return { measures: Number(match[1]) };
  } finally { clearTimeout(timer); }
}

test('the production React build keeps renders out of the global performance timeline', async () => {
  const production = await probe(false);
  assert.equal(production.error, undefined, production.error);
  assert.equal(production.measures, 0, 'the production build must not append render measurements');
});

test('the development React build does append render measurements', async () => {
  // Guards the fix: if a React change stops emitting measurements, the production assertion above
  // would pass for the wrong reason and the entry could drop its build selection unnoticed.
  const development = await probe(true);
  assert.equal(development.error, undefined, development.error);
  assert.ok((development.measures ?? 0) > 0, 'the development build should have appended render measurements');
});
