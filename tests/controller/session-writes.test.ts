/** Session writes are admitted in order: one at a time per session, control actions first. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, runCommand, type CommandPort, type ControllerOptions } from '../../src/controller/index.ts';
import { readTrace } from '../../src/controller/trace-log.ts';
import { parseCommand } from '../../src/slash/index.ts';
import type { ObjectValue } from '../../src/transport/wire.ts';
import { host, until } from '../support/host.ts';

/** A port that runs nothing cancellable; none of these cases needs one. */
const port: CommandPort = { run: async () => undefined };

/** Start a controller on `s1` with a trace file; the caller owns both through `t.after`. */
async function controller(t: { after(fn: () => void | Promise<void>): void },
  directory: string, options: Partial<ControllerOptions> = {}) {
  const fixture = await host();
  t.after(() => fixture.close());
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1',
    tracePath: join(directory, 'trace.log'), ...options });
  t.after(async () => { await app.stop(); });
  app.start();
  await until(() => app.queries.record.ready);
  return { fixture, app };
}

/** Every mutation admission the trace recorded, oldest first. */
async function admissions(path: string): Promise<{ session?: string; lane?: string; waited?: boolean }[]> {
  return (await readTrace(path)).filter(line => !line.startsWith('#'))
    .map(line => JSON.parse(line) as { event: string; session?: string; lane?: string; waited?: boolean })
    .filter(entry => entry.event === 'mutation');
}

/** Await one write, failing with a reason instead of hanging when a gate is held for a whole mutation. */
async function bounded<T>(work: Promise<T>, what: string, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test('a slow host command never holds the gate against a cancellation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-mutation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { fixture, app } = await controller(t, directory);
  // The host keeps `/compact` open. A gate held across the reply would make the cancellation wait for
  // the very command it exists to interrupt; `bounded` turns that into a failure instead of a hang.
  // The property is §6.3.1: release when the request is issued, not when it finishes.
  let finish!: () => void;
  fixture.onCommand = () => new Promise<ObjectValue>(resolve => {
    finish = () => resolve({ commandId: 'c1', result: { kind: 'success', text: 'Compacted 8 history items.' } });
  });
  const command = app.session.command('/compact', new AbortController().signal);
  await until(() => fixture.calls.some(call => call.method === 'commands/execute'));
  // Bounded so a gate held across the reply fails here with a reason instead of hanging the suite.
  await bounded(app.session.cancelTurn(), 'the cancellation');
  const methods = fixture.calls.map(call => call.method);
  assert.ok(methods.indexOf('session/cancel') > methods.indexOf('commands/execute'),
    `the cancel must reach the host while the command is open: ${methods.join(',')}`);
  finish();
  assert.equal(await command, 'Compacted 8 history items.');
  await app.trace?.settle();
  // The trace names the dispatch order and the lane each write used.
  assert.deepEqual((await admissions(join(directory, 'trace.log'))).map(entry => `${entry.session}:${entry.lane}:${entry.waited}`),
    ['s1:normal:false', 's1:control:false']);
});

test('a loop sends its turns through the same admission point as the reader', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-mutation-loop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { fixture, app } = await controller(t, directory);
  // The loop's first turn is an internal prompt; nothing about it may bypass the gate that orders
  // the reader's own writes on the same session.
  await runCommand(app, parseCommand('/loop design-review 9'), port);
  await until(() => app.queries.loop?.active === true);
  // Waiting for the request itself is what makes the order below deterministic: its admission is
  // reported before the request is issued, so it is on record before the cancellation is admitted.
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  await app.session.cancelTurn();
  await app.trace?.settle();
  const recorded = await admissions(join(directory, 'trace.log'));
  assert.ok(recorded.length >= 2, JSON.stringify(recorded));
  assert.ok(recorded.every(entry => entry.session === 's1'), JSON.stringify(recorded));
  assert.deepEqual(recorded.map(entry => entry.lane), ['normal', 'control']);
});
