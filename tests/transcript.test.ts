/** Snapshot replacement, durable reconciliation, and stream gap detection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import wrapAnsi from 'wrap-ansi';
import { contentText, Transcript } from '../src/transcript.ts';
import { historyLayout } from '../src/history.ts';
import { snapshot } from './host.ts';

test('reconciles live text with the committed message and replaces on reconnect', () => {
  const transcript = new Transcript();
  transcript.accept(snapshot);
  transcript.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  transcript.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 2, index: 0,
    chunk: { type: 'text-delta', index: 0, text: 'Hello' } } });
  assert.equal(transcript.liveText, 'Hello');
  const event = { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'Hello' }] } } };
  transcript.accept({ type: 'event', event });
  transcript.accept({ type: 'event', event });
  transcript.accept({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'a', revision: 3, index: 1 } });
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.liveText, '');
  transcript.accept({ ...snapshot, records: [] });
  assert.equal(transcript.messages.length, 0);
});

test('reuses the projected conversation across streamed frames and re-folds a split attempt', () => {
  const transcript = new Transcript();
  transcript.accept(snapshot);
  const projected = transcript.messagesForWidth(80);
  transcript.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  transcript.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 2, index: 0,
    chunk: { type: 'text-delta', index: 0, text: 'streamed' } } });
  assert.equal(transcript.liveText, 'streamed');
  assert.equal(transcript.messagesForWidth(80), projected);

  const legacy = new Transcript();
  legacy.accept({ ...snapshot, assistantStream: undefined });
  const durable = legacy.messagesForWidth(80);
  const chunk = (seq: number, texts: string[]) => ({ type: 'event', event: { seq, type: 'chunkrow/text-chunks',
    surfaceOp: 'append', data: { turn: 2, step: 1, index: 0, texts, dt: [] } } });
  legacy.accept(chunk(5, ['live']));
  legacy.accept(chunk(6, [' tail']));
  assert.equal(legacy.liveText, 'live tail');
  assert.equal(legacy.messagesForWidth(80), durable);
  // The retained window can split the live attempt: an older page supplies its beginning.
  legacy.addPage({ records: [chunk(2, ['start '])], hasMore: false });
  assert.equal(legacy.liveText, 'start live tail');
});

test('streams reasoning in full, folds the committed row by layout, and keeps the full text', () => {
  const transcript = new Transcript();
  transcript.accept(snapshot);
  transcript.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  transcript.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 2, index: 0,
    chunk: { type: 'reasoning-delta', index: 0, text: 'First thought. Second thought with detail.' } } });
  assert.equal(transcript.liveTextForWidth(20), '◇ First thought. Second thought with detail.');
  transcript.accept({ type: 'event', event: { seq: 1, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'reasoning', text: 'First thought. Second thought with detail.' },
      { type: 'text', text: 'Answer' }] } } } });
  transcript.accept({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'a', revision: 3, index: 1 } });
  assert.equal(transcript.liveText, '');
  // The committed message keeps every character for search and pickers; folding is a layout choice.
  const message = transcript.messagesForWidth(20)[1]!;
  assert.equal(message.text, '◇ First thought. Second thought with detail.\nAnswer');
  const [foldedReasoning, foldedAnswer] = message.folded!.split('\n');
  assert.match(foldedReasoning!, /^◇ First thought\..*…$/);
  assert.ok(foldedReasoning!.length <= 20, foldedReasoning);
  assert.equal(foldedAnswer, 'Answer');
  const folded = historyLayout(transcript, 20, 'row');
  const expanded = historyLayout(transcript, 20, 'full');
  assert.ok(folded.lines.length < expanded.lines.length);
  assert.equal(folded.lines.some(line => line.includes('detail.')), false);
  assert.equal(expanded.lines.some(line => line.includes('detail.')), true);
});

test('restores compact active streams and detects missed revisions', () => {
  const transcript = new Transcript();
  transcript.accept({ ...snapshot, assistantStream: { revision: 5, activeAttempt: { attemptId: 'a', nextIndex: 2,
    stream: [{ type: 'text-chunks', index: 0, texts: ['你', '好'] }] } } });
  assert.equal(transcript.liveText, '你好');
  assert.throws(() => transcript.accept({ type: 'assistant-stream', frame: { type: 'chunk', revision: 7 } }), /revision gap/);
});

test('excludes model-only replacement copies and neutralizes terminal controls', () => {
  const transcript = new Transcript();
  transcript.accept(snapshot);
  transcript.accept({ type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: { op: 'replace', start: 0, end: 0 },
    data: { content: [{ type: 'text', text: 'replacement' }] } } });
  transcript.accept({ type: 'event', event: { seq: 2, type: 'tool/result', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: '\u001b]52;c;secret\u0007' }] } } } });
  assert.equal(transcript.messages.length, 2);
  assert(!transcript.messages[1]!.text.includes('\u001b'));
});

test('reads legacy packed history and reconciles its live tail without duplicating messages', () => {
  const transcript = new Transcript();
  const text = { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 6, time: 1000,
    data: { turn: 1, step: 1, index: 0, dt: [1], texts: ['Hel', 'lo'] } } };
  transcript.accept({ ...snapshot, header: { version: 0 }, cursor: 7, assistantStream: undefined,
    records: [{ ...snapshot.records[0], event: { ...snapshot.records[0]!.event, seq: 5 } }, text] });
  assert.equal(transcript.ready, true);
  assert.equal(transcript.liveText, 'Hello');
  transcript.accept(text);
  assert.equal(transcript.liveText, 'Hello');
  transcript.addPage({ records: [{ type: 'event', event: { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } } }], hasMore: false });
  assert.equal(transcript.liveText, 'Hello');
  assert.equal(transcript.beforeSeq, 1);
  transcript.accept({ type: 'event', event: { type: 'assistant/chunk', seq: 8,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '!' } } } });
  assert.equal(transcript.liveText, 'Hello!');
  transcript.accept({ type: 'event', event: { type: 'assistant/message', seq: 9, surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: 'Hello!' }] } } } });
  assert.equal(transcript.liveText, '');
  assert.equal(transcript.messages.at(-1)?.text, 'Hello!');
  assert.throws(() => transcript.addPage({ records: [{ type: 'unexpected', event: {} }] }), /history record.*unexpected/i);
});

test('rejects unrecognized packed events and inconsistent packed member counts', () => {
  const transcript = new Transcript();
  assert.throws(() => transcript.accept({ ...snapshot, assistantStream: undefined,
    records: [{ type: 'chunks', event: { type: 'unknown/chunks', seq: 0, data: {} } }] }), /Unsupported packed history event/);
  assert.throws(() => transcript.accept({ ...snapshot, assistantStream: undefined,
    records: [{ type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 0,
      data: { turn: 1, step: 1, index: 0, dt: [], texts: ['a', 'b'] } } }] }), /Invalid packed history member count/);
});

test('tool summaries hide arguments and nested results in live output and history', () => {
  const transcript = new Transcript();
  transcript.accept(snapshot);
  transcript.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  transcript.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 2, index: 0,
    chunk: { type: 'tool-call-delta', index: 0, id: 'call', name: 'bash', argumentsDelta: 'PRIVATE_COMMAND' } } });
  assert.equal(transcript.liveText, '⚙ bash');
  transcript.accept({ type: 'event', event: { seq: 1, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'tool-call', id: 'call', name: 'bash', arguments: 'PRIVATE_COMMAND' }] } } } });
  transcript.accept({ type: 'event', event: { seq: 2, type: 'tool/result', surfaceOp: 'append',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'call', isError: true,
      content: [{ type: 'text', text: 'PRIVATE_RESULT' }, { type: 'custom-tool-data', secret: 'PRIVATE_DATA' }] }] } } } });
  assert.deepEqual(transcript.messages.slice(1).map(message => message.text), ['⚙ bash', '✗ bash · failed']);
  assert.equal(JSON.stringify(transcript.messages).includes('PRIVATE'), false);
});

test('tool descriptions follow their call IDs and remain a single terminal row', () => {
  const transcript = new Transcript();
  transcript.accept(snapshot);
  transcript.accept({ type: 'event', event: { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [
    { type: 'tool-call', id: 'a', name: 'bash', arguments: JSON.stringify({ description: 'Read package.json', command: 'cat package.json', other: 'PRIVATE_OTHER' }) },
    { type: 'tool-call', id: 'b', name: 'bash', arguments: JSON.stringify({ command: 'printf "长命令内容"\n'.repeat(20) }) },
  ] } } } });
  transcript.accept({ type: 'event', event: { seq: 2, type: 'tool/result', surfaceOp: 'append', data: { message: { content: [
    { type: 'tool-result', toolCallId: 'b', isError: true, content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }] },
    { type: 'tool-result', toolCallId: 'a', isError: false, content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }] },
  ] } } } });
  const messages = transcript.messagesForWidth(32).slice(1);
  assert.equal(messages[0]!.text.split('\n')[0], '⚙ bash · Read package.json');
  assert.equal(messages[1]!.text.split('\n')[1], '✓ bash · Read package.json');
  assert.ok(messages[1]!.text.startsWith('✗ bash · printf'));
  assert.ok(messages.every(message => message.compact));
  for (const message of messages) for (const row of message.text.split('\n')) {
    assert.equal(wrapAnsi(row, 32, { hard: true, wordWrap: false }).includes('\n'), false);
    assert.equal(row.includes('PRIVATE'), false);
  }
  assert.ok(messages[1]!.text.split('\n')[0]!.endsWith('…'));
  assert.equal(contentText([{ type: 'tool-call', name: 'read', arguments: '{unfinished' }]), '⚙ read');
  transcript.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'live', revision: 1 } });
  transcript.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'live', revision: 2, index: 0,
    chunk: { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c', name: 'bash',
      arguments: JSON.stringify({ description: 'Read package.json', command: 'cat package.json' }) } } } });
  assert.equal(transcript.liveTextForWidth(32), '⚙ bash · Read package.json');
  assert.equal(transcript.liveToolOnly, true);
});
