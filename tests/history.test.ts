/** History navigation operates on visible record sequences and SGR input packets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyLayout } from '../src/history.ts';
import { isMouseReport, wheelDirection } from '../src/mouse.ts';
import { Transcript } from '../src/transcript.ts';
import { Controller } from '../src/controller.ts';
import { host, snapshot, until } from './host.ts';

test('history offsets refer to visible messages', () => {
  const transcript = new Transcript(); transcript.accept(snapshot);
  const layout = historyLayout(transcript, 30);
  assert.equal(layout.offsets.get(0), 0);
  assert.deepEqual(layout.lines, ['❯ User', '你好', '']);
});

test('mouse decoding ignores buttons, motion, releases and horizontal wheels', () => {
  for (const modifiers of [0, 4, 8, 16, 28]) {
    assert.equal(wheelDirection(`\x1b[<${64 + modifiers};1;2M`), 1);
    assert.equal(wheelDirection(`\x1b[<${65 + modifiers};1;2M`), -1);
  }
  for (const button of [0, 1, 2, 32, 66, 67, 96]) assert.equal(wheelDirection(`\x1b[<${button};1;2M`), 0);
  assert.equal(wheelDirection('\x1b[<64;1;2m'), 0);
  assert.equal(isMouseReport('\x1b[<0;1;2m'), true);
  assert.equal(isMouseReport('hello'), false);
});

test('workspace search preserves global truncation and validates host responses', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  t.after(() => controller.stop()); controller.start();
  await until(() => controller.state.transcript.ready);
  fixture.searchResult = { items: [{ sessionId: 's1', snippet: 'one' }, { sessionId: 's2', snippet: 'two' }], hasMore: true };
  const signal = new AbortController().signal;
  assert.deepEqual(await controller.searchSessions('one', true, signal), { items: [{ sessionId: 's1', snippet: 'one' }], hasMore: true });
  assert.equal((await controller.searchSessions('one', false, signal)).items.length, 2);
  fixture.searchResult = { items: [{ sessionId: 1, snippet: 'bad' }], hasMore: false };
  await assert.rejects(controller.searchSessions('one', false, signal), /Invalid session search item/);
  fixture.searchResult = { items: [], hasMore: 'false' };
  await assert.rejects(controller.searchSessions('one', false, signal), /Invalid session search response/);
});

test('paging stops on an unadvancing host page and respects cancellation', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { ...snapshot, hasMore: true };
  fixture.onPage = async () => ({ records: [], hasMore: true });
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  t.after(() => controller.stop()); controller.start();
  await until(() => controller.state.transcript.ready);
  await assert.rejects(controller.historyThrough('first', new AbortController().signal), /did not advance/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(controller.historyThrough('first', abort.signal), { name: 'AbortError' });
});

test('stream frames reuse the history index, bound row caching, and retrieve evicted rows on demand', () => {
  const transcript = new Transcript();
  transcript.accept({ ...snapshot, records: Array.from({ length: 1500 }, (_, seq) => ({ type: 'event', event: {
    seq, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: `Message ${seq}` }] } },
  } })) });
  const first = historyLayout(transcript, 80);
  assert.equal(first.length, 4500);
  assert.ok(first.cachedRowCount <= 2048);
  const oldest = first.messages[0]!;
  const parts = oldest.parts;
  let oldReads = 0;
  Object.defineProperty(oldest, 'parts', { get() { oldReads++; return parts; } });
  transcript.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  transcript.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', index: 0, revision: 2,
    chunk: { type: 'text-delta', index: 0, text: 'Live answer' } } });
  const next = historyLayout(transcript, 80);
  assert.equal(next.offsets, first.offsets);
  assert.equal(next.viewport(next.length - 2, next.length).at(-1)?.text, 'Live answer');
  assert.equal(oldReads, 0);
  assert.equal(next.viewport(0, 3)[1]?.text, 'Message 0');
  assert.equal(oldReads, 1);
  assert.ok(next.cachedRowCount <= 2048);
});

test('individual reasoning folds preserve complete searchable text and other messages', () => {
  const transcript = new Transcript();
  transcript.accept({ ...snapshot, records: [1, 2].map(seq => ({ type: 'event', event: {
    seq, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [
      { type: 'reasoning', text: 'Long thought '.repeat(30) + `needle-${seq}` }, { type: 'text', text: `Answer ${seq}` },
    ] } },
  } })) });
  const folded = historyLayout(transcript, 40);
  assert.ok(folded.lines.some(line => line.includes('/think 1')));
  assert.ok(!folded.lines.some(line => line.includes('needle-1')));
  const expanded = historyLayout(transcript, 40, 'row', new Set([1]));
  assert.ok(expanded.lines.some(line => line.includes('needle-1')));
  assert.ok(!expanded.lines.some(line => line.includes('needle-2')));
  assert.ok(transcript.messages[1]!.text.includes('needle-2'));
});
