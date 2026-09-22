/** Published telemetry is a retained read snapshot, never the mutable projection store. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry } from '../../src/session/telemetry.ts';
import { controlFrame } from '../../src/transport/events.ts';
import { object } from '../../src/json.ts';

function mounted() {
  const telemetry = new Telemetry();
  telemetry.accept(controlFrame({ type: 'baseline', value: { projections: { s: { asOfSeq: 1,
    values: { title: { text: 'original' } } } }, queues: {}, jobs: {} } }));
  return telemetry;
}

test('a retained projection snapshot does not change when a newer frame arrives', () => {
  const telemetry = mounted();
  const before = telemetry.view('s');
  telemetry.accept(controlFrame({ type: 'projection', sessionId: 's', key: 'title', seq: 2, value: { text: 'new' } }));
  assert.equal(object(before.values.title).text, 'original');
  assert.equal(object(telemetry.view('s').values.title).text, 'new');
});

test('retained projection and queue values do not alias incoming frames', () => {
  const telemetry = mounted();
  const title = { nested: { text: 'accepted' } };
  telemetry.accept({ kind: 'projection', sessionId: 's', key: 'title', seq: 2, value: title });
  title.nested.text = 'changed by sender';
  assert.equal(object(object(telemetry.view('s').values.title).nested).text, 'accepted');
  const item = { id: 'q', placement: 'queued' as const, text: 'queued text' };
  telemetry.accept({ kind: 'queue', sessionId: 's', items: [item] });
  item.text = 'changed by sender';
  assert.equal(telemetry.pending('s')[0]?.text, 'queued text');
});

test('readers cannot mutate projection values, nested objects or queue entries', () => {
  const telemetry = mounted();
  const view = telemetry.view('s');
  assert.equal(Reflect.set(view.values, 'injected', true), false);
  assert.equal(Reflect.set(object(view.values.title), 'text', 'injected'), false);
  telemetry.accept({ kind: 'queue', sessionId: 's', items: [{ id: 'q', placement: 'queued', text: 'original' }] });
  const queue = telemetry.pending('s');
  assert.equal(Reflect.set(queue, 'length', 0), false);
  assert.equal(Reflect.set(queue[0]!, 'text', 'injected'), false);
  assert.equal(telemetry.pending('s')[0]?.text, 'original');
});

test('the read capability caches unchanged views and refreshes counts without changing retained snapshots', () => {
  const telemetry = mounted();
  const reader = telemetry.reader;
  assert.equal('accept' in reader, false);
  assert.equal('snapshot' in reader, false);
  assert.equal(Reflect.set(reader, 'ready', false), false);
  assert.equal(reader.ready, true);
  const original = reader.view('s');
  assert.equal(reader.view('s'), original);
  telemetry.accept({ kind: 'projection', sessionId: 's', seq: 0, key: 'title', value: 'stale' });
  assert.equal(reader.view('s'), original);
  telemetry.accept({ kind: 'queue', sessionId: 's', items: [{ id: 'q', placement: 'queued', text: 'a' }] });
  const queued = reader.view('s');
  assert.equal(queued.queued, 1);
  assert.equal(original.queued, undefined);
  telemetry.accept({ kind: 'jobs', sessionId: 's', count: 2 });
  assert.equal(reader.view('s').jobs, 2);
  assert.equal(queued.jobs, undefined);
  telemetry.accept({ kind: 'baseline', projections: new Map(), queues: new Map(), jobs: new Map() });
  assert.deepEqual(reader.view('s').values, {});
  assert.equal(reader.view('s').queued, undefined);
  assert.deepEqual(reader.pending('s'), []);
  assert.equal(object(original.values.title).text, 'original');
});
