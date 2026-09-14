/** Session prompt index: durable folds, reloadable budgets, and the refill that closes the recall gap. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptCache, PromptIndex } from '../../src/session/info.ts';
import { Transcript } from '../../src/session/transcript.ts';

/** Two entries force eviction in tests without pushing 2,000 prompts through a snapshot. */
const small = { maxEntries: 2, maxBytes: 1_000_000 };

test('recall traverses prompts, deduplicates neighbours and restores the draft', () => {
  const index = new PromptIndex();
  index.record('first'); index.record('second'); index.record('second');
  assert.equal(index.move(-1, 'unsent'), 'second');
  assert.equal(index.move(-1, 'second'), 'first');
  assert.equal(index.move(-1, 'first'), 'first');
  assert.equal(index.move(1, 'first'), 'second');
  assert.equal(index.move(1, 'second'), 'unsent');
  assert.equal(index.move(1, 'unsent'), 'unsent');
  index.resetCursor();
  assert.equal(index.move(1, 'edited second'), 'edited second');
});

test('a durable echo upgrades a locally recorded prompt instead of duplicating it', () => {
  const index = new PromptIndex();
  index.record('hello');
  assert.equal(index.length, 1);
  index.append([{ seq: 7, text: 'hello' }]);
  assert.equal(index.length, 1);
  assert.deepEqual(index.items[0], { seq: 7, text: 'hello', durable: true });
  // The refill boundary is the durable sequence, not the provisional one a local entry carries.
  assert.equal(index.oldest, 7);
});

test('budgets evict the oldest entry while its durable boundary stays reloadable', () => {
  const index = new PromptIndex(small);
  index.append([{ seq: 1, text: 'one' }, { seq: 2, text: 'two' }, { seq: 3, text: 'three' }]);
  assert.deepEqual(index.items.map(entry => entry.text), ['two', 'three']);
  assert.equal(index.oldest, 2);
  // The window can still supply the evicted prefix, so it is recoverable rather than lost.
  assert.equal(index.prepend([{ seq: 1, text: 'one' }]), 1);
  let value = '';
  for (let step = 0; step < 3; step++) value = index.move(-1, value);
  assert.equal(value, 'one');
});

test('prepending older prompts keeps the active cursor on the entry it selected', () => {
  const index = new PromptIndex();
  index.append([{ seq: 3, text: 'recent-1' }, { seq: 4, text: 'recent-2' }]);
  assert.equal(index.move(-1, ''), 'recent-2');
  assert.equal(index.move(-1, ''), 'recent-1');
  assert.equal(index.atOldest, true);
  index.prepend([{ seq: 1, text: 'old-1' }, { seq: 2, text: 'old-2' }]);
  assert.equal(index.length, 4);
  assert.equal(index.atOldest, false);
  assert.equal(index.move(-1, ''), 'old-2');
  assert.equal(index.move(-1, ''), 'old-1');
  assert.equal(index.atOldest, true);
});

test('prepending skips empty and oversized prompts and keeps the parked draft', () => {
  const index = new PromptIndex();
  index.append([{ seq: 1, text: 'recent' }]);
  assert.equal(index.move(-1, 'unsent draft'), 'recent');
  index.prepend([{ seq: 0, text: '' }, { seq: 0, text: 'old' }, { seq: 0, text: 'x'.repeat(150000) }]);
  assert.equal(index.length, 2);
  assert.equal(index.move(-1, ''), 'old');
  assert.equal(index.move(1, ''), 'recent');
  assert.equal(index.move(1, ''), 'unsent draft');
});

test('only the prompts newer than the last fold are scanned again', () => {
  const transcript = new Transcript();
  const prompt = (seq: number) => ({ type: 'event', event: { seq, type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text: `p${seq}` }] } } });
  transcript.accept({ type: 'snapshot', cursor: 2, hasMore: false, records: [prompt(1), prompt(2)] });
  const index = new PromptIndex();
  index.fold(transcript.promptsSince(index.through));
  assert.deepEqual(index.items.map(entry => entry.text), ['p1', 'p2']);
  // A later frame folds only what arrived after the last fold.
  transcript.accept({ type: 'event', event: { seq: 3, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'p3' }] } } });
  index.fold(transcript.promptsSince(index.through));
  assert.deepEqual(index.items.map(entry => entry.text), ['p1', 'p2', 'p3']);
});

test('an assistant-only frame advances the fold watermark instead of being rescanned', () => {
  const transcript = new Transcript();
  transcript.accept({ type: 'snapshot', cursor: 1, hasMore: false, records: [
    { type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'p1' }] } } } ] });
  const index = new PromptIndex();
  index.fold(transcript.promptsSince(index.through));
  assert.equal(index.through, 1);
  // A turn of assistant records contributes no prompt but must still move the watermark forward.
  transcript.accept({ type: 'event', event: { seq: 2, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: 'answer' }] } } } });
  const fold = transcript.promptsSince(index.through);
  assert.deepEqual(fold.prompts, []);
  assert.equal(fold.through, 2);
  index.fold(fold);
  assert.equal(index.through, 2);
  assert.equal(index.length, 1);
});

test('the loaded window refills prompts the budgets evicted, so recall stays complete', () => {
  const transcript = new Transcript();
  const prompt = (seq: number) => ({ type: 'event', event: { seq, type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text: `p${seq}` }] } } });
  transcript.accept({ type: 'snapshot', cursor: 3, hasMore: false, records: [prompt(1), prompt(2), prompt(3)] });
  const index = new PromptIndex(small);
  index.fold(transcript.promptsSince(index.through));
  assert.deepEqual(index.items.map(entry => entry.text), ['p2', 'p3']);
  // p1 left the index but not the window: the backward step recovers it without a page request.
  assert.equal(index.prepend(transcript.promptsBefore(index.oldest!)), 1);
  assert.deepEqual(index.items.map(entry => entry.text), ['p1', 'p2', 'p3']);
});

test('injected context is not a prompt, in either direction of the window scan', () => {
  const transcript = new Transcript();
  transcript.accept({ type: 'snapshot', cursor: 3, hasMore: false, records: [
    { type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'system' },
      content: [{ type: 'text', text: 'injected context' }] } } },
    { type: 'event', event: { seq: 2, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'real prompt' }] } } },
  ] });
  assert.deepEqual(transcript.promptsSince(-1).prompts.map(entry => entry.text), ['real prompt']);
  assert.deepEqual(transcript.promptsBefore(9).map(entry => entry.text), ['real prompt']);
});

test('PromptCache folds scanned pages in order and only a final call marks it complete', () => {
  const cache = new PromptCache(1_000_000);
  cache.observe('s1', [{ seq: 4, text: 'p4' }, { seq: 5, text: 'p5' }], false);
  cache.observe('s1', [{ seq: 2, text: 'p2' }, { seq: 3, text: 'p3' }], false);
  assert.deepEqual(cache.get('s1')?.prompts.map(prompt => prompt.text), ['p2', 'p3', 'p4', 'p5']);
  assert.equal(cache.get('s1')?.complete, false, 'a partial entry must not let an open skip the walk');
  cache.observe('s1', [], true);
  assert.equal(cache.get('s1')?.complete, true);
  assert.deepEqual(cache.get('s1')?.prompts.map(prompt => prompt.text), ['p2', 'p3', 'p4', 'p5']);
});

test('PromptCache evicts the least recently used session by bytes but always keeps one', () => {
  const cache = new PromptCache(20);
  cache.put('a', { prompts: [{ seq: 1, text: 'x'.repeat(10) }], complete: true });
  cache.put('b', { prompts: [{ seq: 1, text: 'y'.repeat(10) }], complete: true });
  assert.equal(cache.get('a'), undefined, 'the older session was evicted');
  assert.ok(cache.get('b'));
  cache.put('c', { prompts: [{ seq: 1, text: 'z'.repeat(50) }], complete: true });
  assert.ok(cache.get('c'), 'one oversized session is still cached rather than dropped');
});

test('an index that shed a prefix never claims to be exhaustive', () => {
  const index = new PromptIndex(small);
  index.append([{ seq: 1, text: 'one' }, { seq: 2, text: 'two' }, { seq: 3, text: 'three' }]);
  index.settle();
  assert.equal(index.trimmed, true);
  index.markComplete();
  assert.equal(index.exhausted, false, 'the dropped prefix must stay reachable through the lazy path');
});
