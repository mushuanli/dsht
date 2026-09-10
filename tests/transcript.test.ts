/** Snapshot replacement, durable reconciliation, and stream gap detection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Transcript } from '../src/transcript.ts';
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
