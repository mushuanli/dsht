/** Baseline deadlines and subscriptions are reclaimed on cancellation and setup failure. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../../src/transport/client.ts';
import { ConnectionStreams, type StreamHost } from '../../src/controller/connection-streams.ts';
import { Telemetry } from '../../src/session/telemetry.ts';

function host(): StreamHost {
  return { identified() {}, event: () => true, changed() {}, degraded() {}, fail() {} };
}

function timers(t: { mock: { method: typeof test.mock.method } }) {
  const live = new Set<ReturnType<typeof setTimeout>>();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    const timer = set(callback, ms); live.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer: ReturnType<typeof setTimeout>) => { live.delete(timer); clear(timer); });
  return live;
}

test('subscription setup failure clears its startup deadline', async t => {
  const live = timers(t);
  const client = new Client('http://localhost');
  client.subscribe = () => { throw new Error('Socket closed during setup'); };
  const streams = new ConnectionStreams(client, host(), new AbortController().signal);
  await assert.rejects(streams.start(), /Socket closed during setup/);
  streams.close();
  assert.equal(live.size, 0);
});

for (const phase of ['events', 'control']) test(`cancellation while waiting for ${phase} clears deadlines and subscriptions`, async t => {
  const live = timers(t);
  const client = new Client('http://localhost');
  const abort = new AbortController();
  let opened = 0;
  let cancelled = 0;
  let observed = 0;
  let waiting!: () => void;
  const started = new Promise<void>(resolve => { waiting = resolve; });
  let event!: Parameters<Client['subscribe']>[2];
  client.subscribe = (endpoint, _args, listener) => {
    opened++;
    if (endpoint === '$events') event = listener;
    if (phase === 'control' && endpoint === '$events') listener.item({ type: 'ready', clientId: 'test' });
    else waiting();
    return { cancel() { cancelled++; } };
  };
  const streams = new ConnectionStreams(client, { ...host(), identified() { observed++; } }, abort.signal);
  const starting = streams.start();
  await started;
  abort.abort();
  await assert.rejects(starting, { name: 'AbortError' });
  streams.close(); streams.close();
  assert.equal(live.size, 0);
  assert.equal(cancelled, opened);
  const before = observed;
  event.item({ type: 'ready', clientId: 'late' });
  assert.equal(observed, before);
});

test('closing startup directly settles its wait and releases the baseline timer', async t => {
  const live = timers(t);
  const client = new Client('http://localhost');
  let cancelled = 0;
  client.subscribe = () => ({ cancel() { cancelled++; } });
  const streams = new ConnectionStreams(client, host(), new AbortController().signal);
  const starting = streams.start();
  streams.close();
  await assert.rejects(starting, { name: 'AbortError' });
  assert.equal(live.size, 0);
  assert.equal(cancelled, 1);
});

test('a baseline this client cannot apply is reported once, and a later one clears it', async () => {
  const client = new Client('http://localhost');
  const listeners = new Map<string, Parameters<Client['subscribe']>[2]>();
  client.subscribe = (endpoint, _args, listener) => { listeners.set(endpoint, listener); return { cancel() {} }; };
  const telemetry = new Telemetry();
  const published: (string | undefined)[] = [];
  const streamHost: StreamHost = {
    identified() {}, changed() {}, fail() {},
    event: event => { if (event.kind === 'control') telemetry.accept(event.frame); return true; },
    degraded: message => published.push(message),
  };
  const streams = new ConnectionStreams(client, streamHost, new AbortController().signal);
  const starting = streams.start();
  // `$events` reports ready first, which is what lets `start` open the control stream.
  await new Promise(resolve => setImmediate(resolve));
  listeners.get('$events')!.item({ type: 'ready', clientId: 'c' });
  await new Promise(resolve => setImmediate(resolve));
  const control = listeners.get('session/control')!;
  // A baseline with an unreadable queue never becomes the snapshot live metrics need...
  control.item({ type: 'baseline', value: { queues: { s1: 'not a list' }, jobs: {}, projections: {} } });
  await starting;
  await new Promise(resolve => setImmediate(resolve));
  const cause = published.at(-1);
  assert.match(cause!, /Live metrics degraded: /);
  // ...so the updates that follow must not bury that cause under "before baseline".
  control.item({ type: 'projection', sessionId: 's1', key: 'tokenUsage', seq: 1, value: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published.at(-1), cause);
  // A baseline that decodes proves the stream works, so the degradation ends.
  control.item({ type: 'baseline', value: { queues: { s1: [] }, jobs: { s1: [] }, projections: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published.at(-1), undefined);
  streams.close();
});
