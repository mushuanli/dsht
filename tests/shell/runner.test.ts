/** The local `!` runner streams lines, bounds a runaway line and kills the whole process group. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShell } from '../../src/shell/runner.ts';

/** Collect one run's lines and how it ended. */
async function run(command: string, signal = new AbortController().signal) {
  const lines: string[] = [];
  const exit = await runShell(command, {
    cwd: process.cwd(), env: process.env, signal,
    onLine: line => { lines.push(line); },
  });
  return { lines, exit };
}

test('stdout and stderr lines arrive and the exit code is reported', async () => {
  const ok = await run('printf "one\\ntwo\\n"');
  assert.deepEqual(ok.lines, ['one', 'two']);
  assert.deepEqual(ok.exit, { code: 0, signal: null });

  const both = await run('echo out; echo err 1>&2');
  assert.deepEqual([...both.lines].sort(), ['err', 'out']);

  const failed = await run('echo boom 1>&2; exit 3');
  assert.deepEqual(failed.lines, ['boom']);
  assert.equal(failed.exit.code, 3);
});

test('a final line without a newline is still delivered', async () => {
  const { lines } = await run('printf "no-newline"');
  assert.deepEqual(lines, ['no-newline']);
});

test('one line longer than the assemble budget is truncated once, not buffered whole', async () => {
  const { lines } = await run('printf "x%.0s" $(seq 1 20000); printf "\\nafter\\n"');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^x+…$/);
  assert.ok(lines[0]!.length < 9000, 'the retained line stays near the assemble budget');
  assert.equal(lines[1], 'after');
});

test('cancelling kills the whole process group and resolves', async () => {
  const abort = new AbortController();
  const started = Date.now();
  const run$ = run('sleep 30 & sleep 30', abort.signal);
  await new Promise(resolve => setTimeout(resolve, 100));
  abort.abort();
  const { exit } = await run$;
  assert.ok(Date.now() - started < 5_000, 'cancellation does not wait for the command');
  assert.equal(typeof exit.code === 'number' ? exit.code !== 0 : true, true, 'the command did not exit cleanly');
});

test('an aborted signal never starts the command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-runner-'));
  const abort = new AbortController();
  abort.abort();
  const { exit } = await run(`: > ${join(directory, 'ran')}; sleep 30`, abort.signal);
  // Nothing was spawned, so the command cannot have produced its side effect.
  await assert.rejects(readFile(join(directory, 'ran'), 'utf8'));
  assert.equal(exit.signal, 'SIGTERM');
  await rm(directory, { recursive: true, force: true });
});
