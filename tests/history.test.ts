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
  assert.deepEqual(layout.lines, ['You', '你好', '']);
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
