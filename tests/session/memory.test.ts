/** History budgets preserve reloadability, live state, and explicit ownership of read-only windows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Transcript, contentText } from '../../src/session/transcript.ts';
import { historyLayout, releaseHistoryLayout } from '../../src/session/history.ts';
import { historyLimits } from '../../src/session/memory.ts';
import { Controller } from '../../src/controller/controller.ts';
import { object, type ObjectValue } from '../../src/transport/wire.ts';
import { host, snapshot, until } from '../support/host.ts';

const message = (seq: number, text = `Message ${seq}`): ObjectValue => ({ type: 'event', event: {
  seq, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text }] },
} });

function filled(count: number, text?: string) {
  const transcript = new Transcript();
  transcript.accept({ ...snapshot, cursor: count - 1, records: Array.from({ length: count }, (_, seq) => message(seq, text)) });
  return transcript;
}

test('record and payload budgets reclaim a prefix with hysteresis and advance its reload cutoff', () => {
  const transcript = filled(10);
  transcript.accept(message(10));
  const bytes = transcript.retainedBytes;
  assert.equal(transcript.trimHistory({ maxRecords: 8, maxBytes: 100_000 }), 5);
  assert.equal(transcript.retainedRecordCount, 6);
  assert.equal(transcript.beforeSeq, 5);
  assert.equal(transcript.cursor, 10);
  assert.equal(transcript.hasMore, true);
  assert.ok(transcript.retainedBytes < bytes);
  transcript.addPage({ records: [message(3), message(4)], hasMore: true });
  assert.equal(transcript.beforeSeq, 3);
  assert.equal(transcript.messages[0]?.text, 'Message 3');
  const large = filled(80, 'Large text '.repeat(1000));
  assert.ok(large.trimHistory({ maxRecords: 2000, maxBytes: 1_000_000 }) > 0);
  assert.ok(large.retainedBytes <= 750_000);
});

test('trimming keeps a compact prompt and tool identity when their full messages are evicted', () => {
  const transcript = filled(1, 'Original prompt');
  transcript.accept({ type: 'event', event: { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'tool-call', id: 't', name: 'bash', arguments: '{"description":"Run tests","command":"npm test"}' }] } } } });
  transcript.accept({ type: 'event', event: { seq: 2, type: 'tool/result', surfaceOp: 'append', data: { message: { content: [{ type: 'tool-result', toolCallId: 't', isError: false }] } } } });
  transcript.accept({ type: 'event', event: { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'reasoning', text: 'Retained thought' }] } } } });
  transcript.trimHistory({ maxRecords: 2, maxBytes: 100_000 });
  assert.equal(transcript.thoughts[0]?.prompt, 'Original prompt');
  transcript.addPage({ records: [message(0, 'Original prompt')], hasMore: false });
  assert.equal(transcript.latestPrompt, 'Original prompt');
  const result = filled(1, 'Original prompt');
  result.accept({ type: 'event', event: { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'tool-call', id: 't', name: 'bash', arguments: '{"description":"Run tests"}' }] } } } });
  result.accept({ type: 'event', event: { seq: 2, type: 'tool/result', surfaceOp: 'append', data: { message: { content: [{ type: 'tool-result', toolCallId: 't', isError: false }] } } } });
  result.trimHistory({ maxRecords: 1, maxBytes: 100_000 });
  assert.equal(result.messages[0]?.text, '✓ bash · Run tests');
});

test('dispose releases transcript and layout caches and refuses late content', () => {
  const transcript = filled(10);
  const layout = historyLayout(transcript, 80);
  assert.ok(layout.cachedRowCount > 0);
  releaseHistoryLayout(transcript); transcript.dispose();
  assert.equal(layout.cachedRowCount, 0);
  assert.equal(transcript.retainedRecordCount, 0);
  assert.equal(transcript.retainedBytes, 0);
  assert.equal(transcript.messages.length, 0);
  transcript.accept(message(100));
  transcript.addPage({ records: [message(0)], hasMore: false });
  assert.equal(transcript.messages.length, 0);
});

test('command indentation survives truncation and the terminal row renderer', () => {
  const transcript = new Transcript();
  transcript.accept({ ...snapshot, records: [{ type: 'event', event: { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [
    { type: 'tool-call', id: 't', name: 'bash', arguments: JSON.stringify({ description: 'Run tests', command: 'npm test ' + '中文'.repeat(20) }) },
  ] } } } }] });
  const command = historyLayout(transcript, 24).lines[1]!;
  assert.ok(command.startsWith('  $ npm test '), command);
  assert.ok(command.endsWith('…'));
  assert.equal(contentText([{ type: 'tool-call', name: 'bash', arguments: '{"description":"Run tests","command":"npm test"}' }]).split('\n')[1], '  $ npm test');
});

test('history limit options reject unusable values', () => {
  assert.deepEqual(historyLimits('100', '4'), { maxRecords: 100, maxBytes: 4 * 1048576 });
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) assert.throws(() => historyLimits(value));
  assert.throws(() => historyLimits(undefined, '9007199254740991'));
});

test('swapping sessions releases old bodies and pinned reading delays reclaim until returning to live', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, undefined, { maxRecords: 4, maxBytes: 100_000 });
  t.after(() => controller.stop()); controller.start(); await until(() => controller.state.transcript.ready);
  controller.pinHistory(true);
  for (let seq = 1; seq <= 10; seq++) fixture.follow(message(seq));
  await until(() => controller.state.transcript.retainedRecordCount === 11);
  const old = controller.state.transcript;
  controller.pinHistory(false);
  assert.equal(old.retainedRecordCount, 3);
  const layout = historyLayout(old, 80);
  await controller.selectSession('s2'); await until(() => controller.state.transcript.ready);
  assert.equal(old.retainedRecordCount, 0);
  assert.equal(old.retainedBytes, 0);
  assert.equal(layout.cachedRowCount, 0);
});

test('paged search keeps live history unchanged, bounds matches, and loads only a selected target window', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const records = Array.from({ length: 500 }, (_, seq) => message(seq, `needle ${seq} ` + 'payload '.repeat(300)));
  fixture.followSnapshot = { ...snapshot, cursor: 499, hasMore: true, records: records.slice(-20) };
  fixture.onPage = async (): Promise<ObjectValue> => {
    const request = object(object(object(fixture.calls.at(-1)!.payload).args).request);
    const before = Number(request.beforeSeq);
    return { records: records.slice(Math.max(0, before - 80), before), hasMore: before > 80 };
  };
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  t.after(() => controller.stop()); controller.start(); await until(() => controller.state.transcript.ready);
  const source = controller.state.transcript;
  const bytes = source.retainedBytes;
  const matches = await controller.searchHistory('needle', new AbortController().signal);
  assert.equal(matches.items.length, 200);
  assert.equal(matches.truncated, true);
  assert.equal(matches.items[0]?.seq, 499);
  assert.ok(matches.items.every(item => item.preview.length <= 160));
  assert.equal(source.retainedRecordCount, 20);
  assert.equal(source.retainedBytes, bytes);
  const window = await controller.historyAt(120, new AbortController().signal);
  assert.equal(window.messages.at(-1)?.seq, 120);
  assert.ok(window.retainedRecordCount <= 80);
  assert.equal(controller.state.transcript, source);
  window.dispose();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(controller.searchHistory('needle', abort.signal), { name: 'AbortError' });
});

test('unused projection bodies are not retained by the controller', () => {
  const controller = new Controller('http://x1:4096', undefined);
  controller.telemetry.accept({ type: 'baseline', value: { projections: { s1: { asOfSeq: 0, values: {
    title: { title: 'Name' }, turnOutline: { turns: ['large body'] },
  } } }, queues: {}, jobs: {} } });
  assert.deepEqual({ ...controller.telemetry.view('s1').values }, { title: { title: 'Name' } });
  controller.telemetry.accept({ type: 'projection', sessionId: 's1', key: 'turnOutline', seq: 1, value: { turns: ['new body'] } });
  assert.equal(controller.telemetry.view('s1').values.turnOutline, undefined);
});
