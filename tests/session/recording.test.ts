/** Project a copied, keyless Harness recording without importing the parent repository. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { historyLayout } from '../../src/session/history.ts';
import { Transcript } from '../../src/session/transcript.ts';
import { object } from '../../src/transport/wire.ts';

test('recorded workspace editing displays tool calls, results, and final assistant output', () => {
  const rows = readFileSync(new URL('../fixtures/workspace-edit.session.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map(line => object(JSON.parse(line)));
  assert.equal(rows[0]?.version, 2);
  const records = rows.slice(1).map((event, seq) => ({ type: 'event', event: { ...event, seq } }));
  const transcript = new Transcript();
  transcript.accept({ type: 'snapshot', cursor: records.length - 1, hasMore: false, records,
    assistantStream: { revision: 0 } });
  const actual = transcript.messages.map(message => `${message.compact ? '' : message.role + '\n'}${message.text}`).join('\n\n') + '\n';
  const expected = readFileSync(new URL('../expected/workspace-edit.txt', import.meta.url), 'utf8');
  assert.equal(actual, expected);
  assert.equal(historyLayout(transcript, 80).lines.join('\n') + '\n', readFileSync(new URL('../expected/workspace-edit-terminal.txt', import.meta.url), 'utf8'));
  assert.equal(transcript.messages.at(-1)?.text, 'DONE');
  assert.equal(transcript.messages.filter(message => message.parts.some(part => part.kind === 'success')).length, 2);
});

test('recorded legacy packed reasoning, tools and text project only their committed messages', () => {
  const frame = JSON.parse(readFileSync(new URL('../fixtures/legacy-packed-history.json', import.meta.url), 'utf8'));
  const transcript = new Transcript();
  transcript.accept(frame);
  assert.equal(transcript.ready, true);
  assert.equal(transcript.liveText, '');
  assert.equal(transcript.messages.filter(message => message.role === 'Assistant').length, 2);
  assert(transcript.messages.some(message => message.parts.some(part => part.kind === 'error' && part.text.startsWith('✗ bash · Run echo HELLO'))));
  assert(transcript.messages.at(-1)?.text.includes('bash is disabled by policy'));
});
