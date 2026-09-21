/** The foreground slot: one operator-driven operation at a time, owned and cancelled by the controller. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller, type ControllerOptions } from '../../src/controller/index.ts';
import { readTrace } from '../../src/controller/trace-log.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { host, until } from '../support/host.ts';

/** Start a controller on `s1`; the caller owns the fixture through `t.after`. */
async function controller(t: { after(fn: () => void | Promise<void>): void }, options: Partial<ControllerOptions> = {}) {
  const fixture = await host();
  t.after(() => fixture.close());
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', ...options });
  t.after(async () => { await app.stop(); });
  app.start();
  await until(() => app.queries.record.ready);
  return { fixture, app };
}

/** A promise plus the resolver that releases it. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('the slot publishes what owns the client and clears itself when the work ends', async t => {
  const { app } = await controller(t);
  assert.equal(app.queries.foreground, undefined);
  assert.equal(app.queries.activity, undefined);
  const held = gate();
  const claimed = app.actions.foreground('history', 'Loading history…', async signal => {
    assert.equal(signal.aborted, false);
    await held.promise;
    return 'done';
  });
  await until(() => app.queries.foreground !== undefined);
  const snapshot = app.queries.foreground!;
  assert.equal(snapshot.kind, 'history');
  assert.equal(snapshot.label, 'Loading history…');
  assert.ok(snapshot.id > 0);
  assert.ok(snapshot.startedAt > 0);
  // The slot is the same fact the composer guard reads, so one claim makes the client busy.
  assert.equal(app.queries.foreground !== undefined, true);
  held.release();
  assert.equal(await claimed, 'done');
  await until(() => app.queries.foreground === undefined);
  assert.equal(app.queries.foreground !== undefined, false);
});

test('one operation at a time: a second claim is refused while the first runs', async t => {
  const { app } = await controller(t);
  const held = gate();
  const first = app.actions.foreground('history', 'First', async () => { await held.promise; return 'first'; });
  await until(() => app.queries.foreground !== undefined);
  // Refused, not queued: the slot serializes what the operator is doing rather than stacking it.
  assert.equal(await app.actions.foreground('search', 'Second', async () => 'second'), undefined);
  assert.equal(app.queries.foreground?.label, 'First');
  held.release();
  assert.equal(await first, 'first');
});

test('a caller that waits for the slot is served in arrival order, and never overtakes a promise', async t => {
  const { app } = await controller(t);
  const order: string[] = [];
  const first = gate();
  const running = app.actions.foreground('history', 'First', async () => { order.push('first'); await first.promise; });
  await until(() => app.queries.foreground?.label === 'First');
  // Two callers wait; a third arrives just as the first one finishes, so it must not overtake them.
  const second = app.actions.foreground('history', 'Second', async () => { order.push('second'); }, true);
  const third = app.actions.foreground('history', 'Third', async () => { order.push('third'); }, true);
  first.release();
  await Promise.all([running, second, third]);
  assert.deepEqual(order, ['first', 'second', 'third']);
  // A caller that does not ask to wait is still refused, which is what D1 wants for the operator's line.
  const held = gate();
  const blocking = app.actions.foreground('command', 'Blocking', async () => { await held.promise; });
  await until(() => app.queries.foreground?.label === 'Blocking');
  assert.equal(await app.actions.foreground('history', 'Impatient', async () => 'never'), undefined);
  held.release();
  await blocking;
});

test('cancelling aborts the running work and settles its claim as undefined', async t => {
  const { app } = await controller(t);
  let sawAbort = false;
  const claimed = app.actions.foreground('command', 'Compacting…', async signal => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true }));
    return 'finished anyway';
  });
  await until(() => app.queries.foreground !== undefined);
  assert.equal(app.actions.cancelForeground(), true);
  assert.equal(await claimed, 'finished anyway');
  assert.equal(sawAbort, true);
  await until(() => app.queries.foreground === undefined);
  // Nothing to cancel once the slot is free.
  assert.equal(app.actions.cancelForeground(), false);
});

test('work started by the operation that owns the slot is never refused for being busy', async t => {
  const { app } = await controller(t);
  // An action invoked from inside a claim belongs to that operation; refusing it would deadlock the
  // very work that owns the slot. `older` is the real case: the paging loop calls it per page.
  const nested = await app.actions.foreground('history', 'Loading history…', async () =>
    await app.actions.older(undefined, app.queries.record));
  assert.equal(nested, true);
  assert.equal(app.state.lastFailure, '');
});

test('each operation is traced with its kind and whether it was cancelled', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-foreground-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { app } = await controller(t, { tracePath: join(directory, 'trace.log') });
  await app.actions.foreground('model', 'Loading models…', async () => 'ok');
  const claimed = app.actions.foreground('search', 'Searching…', async signal => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return 'stopped';
  });
  await until(() => app.queries.foreground?.kind === 'search');
  app.actions.cancelForeground();
  await claimed;
  await app.trace?.settle();
  const events = (await readTrace(join(directory, 'trace.log'))).filter(line => !line.startsWith('#'))
    .map(line => JSON.parse(line) as { event: string; phase?: string; kind?: string; cancelled?: boolean });
  assert.deepEqual(events.filter(entry => entry.event === 'foreground')
    .map(entry => `${entry.phase}:${entry.kind}:${entry.cancelled ?? ''}`),
    ['begin:model:', 'end:model:false', 'begin:search:', 'end:search:true']);
});
