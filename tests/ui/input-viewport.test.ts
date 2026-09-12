/** Composer geometry: tabs, wrapping, folding and the cursor window are pure and independently checked. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorPlace, foldLabel, formatBytes, planDraft, tabStop, windowRows, wrapDraft } from '../../src/ui/input/viewport.ts';

test('wrapping hard-breaks a single line and maps every source offset to a display index', () => {
  const rows = wrapDraft('abcdef', 4);
  assert.deepEqual(rows.map(row => row.text), ['abcd', 'ef']);
  assert.deepEqual(rows.map(row => [row.start, row.end]), [[0, 4], [4, 6]]);
  assert.deepEqual(rows[1]!.map, [0, 1, 2]);
});

test('a newline closes its row and opens the next one', () => {
  const rows = wrapDraft('a\nb', 10);
  assert.deepEqual(rows.map(row => row.text), ['a', 'b']);
  assert.deepEqual(rows.map(row => [row.start, row.end]), [[0, 2], [2, 3]]);
  // A cursor on the newline renders at the end of the row it closes.
  assert.deepEqual(cursorPlace(rows, 1), { row: 0, index: 1, column: 1 });
  assert.deepEqual(cursorPlace(rows, 2), { row: 1, index: 0, column: 0 });
});

test('tabs expand to the next four-column stop without changing source offsets', () => {
  assert.equal(tabStop(0), 4);
  assert.equal(tabStop(1), 3);
  assert.equal(tabStop(4), 4);
  const rows = wrapDraft('a\tb', 20);
  assert.equal(rows[0]!.text, 'a   b');
  assert.deepEqual(rows[0]!.map, [0, 1, 4, 5]);
  // A cursor on the tab still occupies one source character.
  assert.equal(cursorPlace(rows, 1).column, 1);
  assert.equal(cursorPlace(rows, 2).column, 4);
});

test('an empty draft and a trailing newline both keep a row for the cursor', () => {
  assert.deepEqual(wrapDraft('', 10), [{ text: '', start: 0, end: 0, map: [0] }]);
  const rows = wrapDraft('a\n', 10);
  assert.deepEqual(rows.map(row => row.text), ['a', '']);
  assert.deepEqual(cursorPlace(rows, 2), { row: 1, index: 0, column: 0 });
});

test('the window follows the cursor and never exceeds the limit', () => {
  assert.deepEqual(windowRows(3, 0, 5), { start: 0, end: 3 });
  assert.deepEqual(windowRows(10, 9, 3), { start: 7, end: 10 });
  assert.deepEqual(windowRows(10, 0, 3), { start: 0, end: 3 });
  assert.deepEqual(windowRows(10, 4, 1), { start: 4, end: 5 });
});

test('a multiline block taller than the window folds its interior only', () => {
  const plan = planDraft('A\nB\nC\nD', 40, 1);
  assert.equal(plan.rows.length, 3);
  assert.equal(plan.rows[0]!.text, 'A');
  assert.equal(plan.rows[2]!.text, 'D');
  assert.deepEqual(plan.rows[1]!.fold, { from: 2, to: 6, lines: 2, bytes: 4 });
  assert.equal(foldLabel(plan.rows[1]!.fold!), '[2 lines · 4 B]');
  assert.deepEqual(plan.regions, [{ start: 2, end: 6 }]);
});

test('a long single line is never folded, however far it wraps', () => {
  const plan = planDraft('x'.repeat(50), 10, 2);
  assert.equal(plan.regions.length, 0);
  assert.equal(plan.rows.length, 5);
});

test('a multiline block that already fits is left unfolded', () => {
  const plan = planDraft('A\nB\nC', 40, 5);
  assert.equal(plan.regions.length, 0);
  assert.deepEqual(plan.rows.map(row => row.text), ['A', 'B', 'C']);
});

test('few logical lines that wrap past the window still fold, keeping their wrapped head and tail', () => {
  const text = [ 'A'.repeat(10), 'B'.repeat(10), 'C'.repeat(10) ].join('\n');
  const plan = planDraft(text, 4, 5);
  assert.deepEqual(plan.regions, [{ start: 11, end: 22 }]);
  assert.deepEqual(plan.rows.map(row => row.text), ['AAAA', 'AAAA', 'AA', '', 'CCCC', 'CCCC', 'CC']);
  assert.deepEqual(plan.rows[3]!.fold, { from: 11, to: 22, lines: 1, bytes: 11 });
});

test('the fold decision reads the unfolded height, so folding cannot oscillate', () => {
  const text = 'A\n' + Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n') + '\nZ';
  const plan = planDraft(text, 40, 3);
  // The folded rows are far shorter than the limit, yet the plan stays folded.
  assert.ok(plan.rows.length <= 3);
  assert.equal(plan.regions.length, 1);
  assert.equal(foldLabel(plan.rows[1]!.fold!), `[20 lines · ${formatBytes(Buffer.byteLength(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n') + 1), 'utf8'))}]`);
});

test('byte labels stay compact across units', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(6246), '6.1 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});
