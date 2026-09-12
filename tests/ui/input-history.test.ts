/** Recall preserves unsent drafts and bounds retained prompt memory. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputHistory } from '../../src/ui/input/history.ts';

test('recall traverses submissions, deduplicates neighbours and restores the draft', () => {
  const history = new InputHistory();
  history.record('first'); history.record('second'); history.record('second');
  assert.equal(history.move(-1, 'unsent'), 'second');
  assert.equal(history.move(-1, 'second'), 'first');
  assert.equal(history.move(-1, 'first'), 'first');
  assert.equal(history.move(1, 'first'), 'second');
  assert.equal(history.move(1, 'second'), 'unsent');
  assert.equal(history.move(1, 'unsent'), 'unsent');
  assert.equal(history.move(-1, 'unsent'), 'second');
  history.reset();
  assert.equal(history.move(1, 'edited second'), 'edited second');
});

test('recall evicts by entry and byte budgets without retaining oversized input', () => {
  const history = new InputHistory();
  for (let i = 0; i < 201; i++) history.record(String(i));
  let value = '';
  for (let i = 0; i < 300; i++) value = history.move(-1, value);
  assert.equal(value, '1');
  const large = new InputHistory();
  large.record('a'.repeat(70000)); large.record('b'.repeat(70000)); large.record('x'.repeat(150000));
  assert.equal(large.move(-1, ''), 'b'.repeat(70000));
  assert.equal(large.move(-1, ''), 'b'.repeat(70000));
});

test('prepended history stays in front and an active cursor keeps its entry selected', () => {
  const history = new InputHistory();
  history.record('recent-1'); history.record('recent-2');
  assert.equal(history.move(-1, ''), 'recent-2');
  assert.equal(history.move(-1, ''), 'recent-1');
  assert.equal(history.atOldest, true);
  // Older prompts arrive oldest first, so the front of the buffer stays the oldest.
  history.prepend(['old-2', 'old-1']);
  assert.equal(history.length, 4);
  assert.equal(history.atOldest, false);
  assert.equal(history.move(-1, ''), 'old-1');
  assert.equal(history.move(-1, ''), 'old-2');
  assert.equal(history.atOldest, true);
  assert.equal(history.move(1, ''), 'old-1');
  assert.equal(history.move(1, ''), 'recent-1');
});

test('prepending skips empty and oversized prompts and keeps the parked draft', () => {
  const history = new InputHistory();
  history.record('recent');
  assert.equal(history.move(-1, 'unsent draft'), 'recent');
  history.prepend(['', 'old', 'x'.repeat(150000)]);
  assert.equal(history.length, 2);
  assert.equal(history.move(-1, ''), 'old');
  // Returning past the newest entry still restores the draft captured before recall began.
  assert.equal(history.move(1, ''), 'recent');
  assert.equal(history.move(1, ''), 'unsent draft');
});
