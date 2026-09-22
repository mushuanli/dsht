/** Background prompt reads belong to the selected session and must settle on shutdown. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller/controller.ts';
import { host, snapshot, until } from '../support/host.ts';
import { PromptBackfill } from '../../src/session/prompt-backfill.ts';
import { PromptCache, PromptIndex } from '../../src/session/info.ts';
import { Transcript } from '../../src/session/transcript.ts';
import type { Client } from '../../src/transport/client.ts';

const message = (seq: number) => ({ type: 'event', event: { seq, type: 'user/message', surfaceOp: 'append',
  data: { content: [{ type: 'text', text: `prompt-${seq}` }] } } });

function harness(call: Client['call'], ready = true) {
  const abort = new AbortController();
  const record = new Transcript();
  if (ready) record.accept({ ...snapshot, cursor: 5, hasMore: true, records: [message(4), message(5)] });
  const prompts = new PromptIndex({ maxEntries: 3, maxBytes: 1000 });
  prompts.fold(record.promptsSince(-1));
  const selection = { sessionId: 's', revision: 0, record, prompts };
  const cache = new PromptCache();
  let current = true, changes = 0;
  const worker = new PromptBackfill({
    require: () => ({ call, timeoutMs: 5 }) as Client, signal: () => abort.signal,
    online: () => true, current: () => current, changed: () => { changes++; },
  }, cache);
  return { worker, selection, cache, abort, stale: () => { current = false; }, changes: () => changes };
}

test('a missing follow snapshot times out without fetching or publishing', async () => {
  let pages = 0;
  const { worker, selection, changes } = harness(async () => { pages++; return {}; }, false);
  worker.start(selection);
  await worker.settle();
  assert.equal(pages, 0);
  assert.equal(changes(), 0);
  assert.equal(selection.prompts.exhausted, false);
});

test('each background page respects the recall budget even if a later page fails', async () => {
  let pages = 0;
  const { worker, selection, cache, changes } = harness(async () => {
    if (++pages === 1) return { records: [message(2), message(3)], hasMore: true };
    throw new Error('History unavailable');
  });
  worker.start(selection); await worker.settle();
  assert.deepEqual(selection.prompts.items.map(item => item.seq), [3, 4, 5]);
  assert.equal(selection.prompts.exhausted, false);
  assert.equal(cache.get('s'), undefined);
  assert.equal(changes(), 0);
});

for (const stop of ['cancel', 'lifetime', 'selection']) test(`a late backfill page cannot publish after ${stop}`, async () => {
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness(async () => { entered = true; await gate; return { records: [message(3)], hasMore: false }; });
  h.worker.start(h.selection); await until(() => entered);
  if (stop === 'cancel') h.worker.cancel();
  else if (stop === 'lifetime') h.abort.abort();
  else h.stale();
  release(); await h.worker.settle();
  assert.deepEqual(h.selection.prompts.items.map(item => item.seq), [4, 5]);
  assert.equal(h.changes(), 0);
  assert.equal(h.cache.get('s'), undefined);
});

test('a stale selection cannot adopt a complete cache while waiting for its snapshot', async () => {
  const h = harness(async () => { throw new Error('No page expected'); }, false);
  h.cache.put('s', { prompts: [{ seq: 0, text: 'cached' }], complete: true });
  h.worker.start(h.selection);
  await Promise.resolve();
  h.stale(); h.selection.record.ready = true;
  await h.worker.settle();
  assert.equal(h.selection.prompts.length, 0);
  assert.equal(h.changes(), 0);
});

test('ending a generation cancels and awaits its prompt backfill before releasing state', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => { release(); await app.stop(); });
  app.start(); await until(() => app.queries.connectionSettled && app.queries.record.ready);
  const client = app.connection.require();
  const call = client.call.bind(client);
  let paging: AbortSignal | undefined;
  client.call = async (method, params, signal, ...rest) => {
    if (method !== 'session/page') return call(method, params, signal, ...rest);
    paging = signal;
    await gate; // Model a transport that returns a late response despite cancellation.
    return { records: [], hasMore: false };
  };
  fixture.followSnapshot = { ...snapshot, hasMore: true };
  await app.session.selectSession('s2');
  await until(() => paging !== undefined);
  app.session.endGeneration();
  let settled = false;
  const settling = app.session.settle().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(paging?.aborted, true);
  assert.equal(settled, false, 'settle must include the background read');
  const version = app.state.version;
  release(); await settling;
  assert.equal(app.state.version, version, 'the late page cannot publish');
  assert.equal(app.state.session.prompts.exhausted, false);
});
