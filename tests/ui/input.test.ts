/** Readline-style edits preserve Unicode characters and leave application shortcuts untouched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { editInput, type EditState } from '../../src/ui/input/input.tsx';

test('Ctrl+A/E/K/U/Y move, kill and restore without submitting control characters', () => {
  let state: EditState = { text: 'alpha beta', cursor: 6, killed: '' };
  const ctrl = (letter: string) => { state = editInput(state, letter, { ctrl: true }); };
  ctrl('k'); assert.deepEqual(state, { text: 'alpha ', cursor: 6, killed: 'beta' });
  ctrl('y'); assert.equal(state.text, 'alpha beta');
  ctrl('a'); assert.equal(state.cursor, 0);
  ctrl('f'); assert.equal(state.cursor, 1);
  ctrl('b'); assert.equal(state.cursor, 0);
  ctrl('e'); assert.equal(state.cursor, 10);
  ctrl('u'); assert.deepEqual(state, { text: '', cursor: 0, killed: 'alpha beta' });
  ctrl('y'); assert.equal(state.text, 'alpha beta');
  ctrl('c'); assert.equal(state.text, 'alpha beta');
  ctrl('z'); assert.equal(state.text, 'alpha beta');
});

test('word motion, word deletion and forward delete operate at the cursor', () => {
  let state: EditState = { text: 'one two three', cursor: 13, killed: '' };
  state = editInput(state, 'w', { ctrl: true });
  assert.equal(state.text, 'one two ');
  state = editInput(state, 'b', { meta: true }); assert.equal(state.cursor, 4);
  state = editInput(state, 'd', { meta: true }); assert.equal(state.text, 'one  ');
  state = editInput(state, '', { home: true });
  state = editInput(state, 'd', { ctrl: true }); assert.equal(state.text, 'ne  ');
  state = editInput(state, '', { delete: true }); assert.equal(state.text, 'e  ');
  state = editInput(state, 'f', { meta: true }); assert.equal(state.cursor, 1);
  state = editInput(state, '', { end: true }); assert.equal(state.cursor, 3);
  assert.equal(editInput({ text: '', cursor: 0, killed: '' }, 'd', { ctrl: true }).text, '');
  assert.equal(editInput({ text: '   ', cursor: 3, killed: '' }, 'w', { ctrl: true }).text, '');
});

test('movement and deletion preserve composed emoji and combining characters', () => {
  let state: EditState = { text: '中👩‍💻e\u0301', cursor: '中👩‍💻e\u0301'.length, killed: '' };
  state = editInput(state, '', { backspace: true }); assert.equal(state.text, '中👩‍💻');
  state = editInput(state, '', { leftArrow: true }); assert.equal(state.cursor, 1);
  state = editInput(state, '', { delete: true }); assert.equal(state.text, '中');
  state = editInput(state, 'h', { ctrl: true }); assert.equal(state.text, '');
  state = editInput(state, 'a\nb\tc\u0001', {}); assert.equal(state.text, 'a\nb\tc');
});

test('insertion keeps line breaks and tabs while normalizing line endings', () => {
  const insert = (input: string) => editInput({ text: '', cursor: 0, killed: '' }, input, {}).text;
  assert.equal(insert('a\r\nb'), 'a\nb');
  assert.equal(insert('a\rb'), 'a\nb');
  assert.equal(insert('a\tb'), 'a\tb');
  assert.equal(insert('a\u0000b'), 'ab');
  assert.equal(insert('a\u000bb'), 'ab');
  assert.equal(insert('a\u000cb'), 'ab');
  assert.equal(insert('a\u001bb'), 'ab');
  assert.equal(insert('a\u007fb'), 'ab');
  assert.equal(insert('a\u009fb'), 'ab');
  assert.equal(insert('a\n\nb'), 'a\n\nb');
});

test('a folded block moves, deletes and inserts as one object', () => {
  const state: EditState = { text: 'head\nBODY\nBODY\ntail', cursor: 5, killed: '' };
  const regions = [{ start: 5, end: 15 }];
  const left = editInput({ ...state, cursor: 15 }, '', { leftArrow: true }, regions);
  assert.equal(left.cursor, 5);
  const right = editInput(state, '', { rightArrow: true }, regions);
  assert.equal(right.cursor, 15);
  const backspace = editInput({ ...state, cursor: 15 }, '', { backspace: true }, regions);
  assert.deepEqual({ text: backspace.text, cursor: backspace.cursor }, { text: 'head\ntail', cursor: 5 });
  const forward = editInput(state, '', { delete: true }, regions);
  assert.deepEqual({ text: forward.text, cursor: forward.cursor }, { text: 'head\ntail', cursor: 5 });
  // Word and line motion never park the cursor inside the hidden range.
  assert.equal(editInput(state, 'f', { meta: true }, regions).cursor, 15);
  assert.equal(editInput({ ...state, cursor: 10 }, '', { leftArrow: true }, regions).cursor, 5);
});

test('navigation, completion and submission keys stay with their application owners', () => {
  const state = { text: '@file', cursor: 5, killed: '' };
  for (const key of [{ return: true }, { escape: true }, { tab: true }, { upArrow: true }, { pageUp: true }]) {
    assert.equal(editInput(state, '', key), state);
  }
  assert.equal(editInput(state, 'x', { eventType: 'release' }), state);
});
