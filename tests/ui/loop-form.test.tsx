/** The `/loop` record list and parameter form: defaults visible, values replaced in place. */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { LoopDialog, LoopMenu, loopRecordDefaults, type LoopRun } from '../../src/ui/dialogs/loop.tsx';
import type { LoopRecord } from '../../src/contracts.ts';

const RECORD: LoopRecord = { name: 'design-review', title: 'Design review', steps: 10,
  artifact: 'DESIGN-REVIEW.md', defaultScore: 8, defaultTries: 10, vars: {} };
const SECOND: LoopRecord = { ...RECORD, name: 'designdoc-review', title: 'Designdoc review · tui-design.md',
  artifact: 'DESIGN-DOC-REVIEW.md', vars: { path: 'tui-design.md' } };

/** Deliver one key sequence inside act, so Ink flushes the frame it produces. */
async function press(ui: ReturnType<typeof render>, value: string): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  try {
    await act(async () => { ui.stdin.write(value); });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}

/** Mount the form with recording actions. */
function mount(enabled = true, record = RECORD) {
  const calls: { start: LoopRun[]; back: number; close: number } = { start: [], back: 0, close: 0 };
  const ui = render(<LoopDialog record={record} enabled={enabled}
    onStart={run => calls.start.push(run)}
    onBack={() => { calls.back += 1; }}
    onClose={() => { calls.close += 1; }} />);
  return { ui, calls, frame: () => ui.lastFrame() ?? '' };
}

test('the record list names every record, its rounds and its defaults', () => {
  const ui = render(<LoopMenu records={[RECORD, SECOND]} index={1} />);
  try {
    const frame = ui.lastFrame()!;
    assert.match(frame, /design-review · Design review · 10 rounds · pass 8 · ≤10 tries · DESIGN-REVIEW\.md/);
    // The highlighted row is the one Enter would confirm.
    assert.match(frame, /❯ designdoc-review · Designdoc review · tui-design\.md · 10 rounds/);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('a record defaults a full run from its first round', () => {
  assert.deepEqual(loopRecordDefaults(RECORD), { from: 1, to: 10, score: 8, tries: 10 });
});

test('a record pointed at something lists that input beside its defaults', () => {
  // The artifact column is dropped here so the variable survives the row's width limit.
  const target = { ...RECORD, artifact: undefined, vars: { path: 'tui-design.md' } };
  const ui = render(<LoopMenu records={[target]} index={0} />);
  try { assert.match(ui.lastFrame()!, /path tui-design\.md/); }
  finally { ui.unmount(); ui.cleanup(); }
});

test('a record variable is a row the form edits, and Start carries the new value', async () => {
  const { ui, calls, frame } = mount(true, SECOND);
  try {
    // The record's own input leads the editable rows, above the shared limits.
    assert.match(frame(), /path\s+tui-design\.md/);
    await press(ui, '\u001b[B'); // path
    await press(ui, 'docs/other.md'); // replaces the default
    await press(ui, '\r'); // commit, move to From
    assert.match(frame(), /path\s+docs\/other\.md · default tui-design\.md/);
    await press(ui, '\u001b[A'); await press(ui, '\u001b[A'); // back to Start, past the path row
    await press(ui, '\r');
    assert.deepEqual(calls.start, [{
      limits: { from: 1, to: 10, score: 8, tries: 10 }, vars: { path: 'docs/other.md' } }]);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('a record variable refuses to be emptied instead of rendering a blank target', async () => {
  const { ui, calls, frame } = mount(true, SECOND);
  try {
    await press(ui, '\u001b[B'); // path
    for (let index = 0; index < 'tui-design.md'.length; index += 1) await press(ui, '\x7f');
    await press(ui, '\r');
    assert.match(frame(), /path: a value is required/);
    assert.deepEqual(calls.start, []);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('the form shows the defaults and starts with them when nothing is edited', async () => {
  const { ui, calls, frame } = mount();
  try {
    for (const text of ['Run loop record · design-review', 'Start run', '← Choose another record']) {
      assert.ok(frame().includes(text), frame());
    }
    assert.match(frame(), /From\s+1/);
    assert.match(frame(), /To\s+10/);
    assert.match(frame(), /Pass\s+8/);
    assert.match(frame(), /Tries\s+10/);
    // The cursor starts on Start, so the fewest keystrokes are Enter, Enter.
    await press(ui, '\r');
    assert.deepEqual(calls.start, [{ limits: { from: 1, to: 10, score: 8, tries: 10 }, vars: {} }]);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('typing over a value replaces it and Start runs the edited values', async () => {
  const { ui, calls, frame } = mount();
  try {
    await press(ui, '\u001b[B'); // From
    await press(ui, '2');
    await press(ui, '\r'); // commit, move to To
    await press(ui, '\u001b[A'); await press(ui, '\u001b[A'); // back to Start
    await press(ui, '\r');
    assert.deepEqual(calls.start, [{ limits: { from: 2, to: 10, score: 8, tries: 10 }, vars: {} }]);
    // An edited value still says what the record would have used.
    assert.match(frame(), /From\s+2 · default 1/);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('an arrow commits the box being left, so Start needs no Enter per value', async () => {
  const { ui, calls, frame } = mount();
  try {
    await press(ui, '\u001b[B'); // From
    await press(ui, '2');
    await press(ui, '\u001b[B'); // down to To already took From with it
    assert.match(frame(), /From\s+2 · default 1/);
    await press(ui, '4'); // To
    await press(ui, '\u001b[B'); // to Pass, taking To with it
    await press(ui, '\u001b[A'); await press(ui, '\u001b[A'); await press(ui, '\u001b[A'); // back to Start
    await press(ui, '\r');
    assert.deepEqual(calls.start, [{ limits: { from: 2, to: 4, score: 8, tries: 10 }, vars: {} }]);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('a value that cannot be used keeps the cursor on its row', async () => {
  const { ui, calls, frame } = mount();
  try {
    await press(ui, '\u001b[B'); await press(ui, '\u001b[B'); await press(ui, '\u001b[B'); // Pass
    await press(ui, '\x7f'); await press(ui, '1'); await press(ui, '1');
    await press(ui, '\u001b[B'); // Arrow away: refused, so the row stays selected.
    assert.match(frame(), /Pass: passing score, 0–10/);
    assert.match(frame(), /❯ Pass/);
    assert.deepEqual(calls.start, []);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('an out-of-range value is refused instead of starting a run', async () => {
  const { ui, calls, frame } = mount();
  try {
    await press(ui, '\u001b[B'); await press(ui, '\u001b[B'); await press(ui, '\u001b[B'); // Pass
    await press(ui, '\x7f'); // drop the default 8
    await press(ui, '1'); await press(ui, '1');
    await press(ui, '\r');
    assert.match(frame(), /Pass: passing score, 0–10/);
    assert.deepEqual(calls.start, []);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('a reversed range is refused before anything starts', async () => {
  const { ui, calls, frame } = mount();
  try {
    await press(ui, '\u001b[B'); // From
    await press(ui, '9');
    await press(ui, '\r'); // commit, already on To
    await press(ui, '\x7f'); await press(ui, '\x7f'); // drop the default 10
    await press(ui, '3');
    await press(ui, '\r');
    assert.match(frame(), /To must be at least From/);
    assert.deepEqual(calls.start, []);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('Esc abandons an edit first, then leaves the form', async () => {
  const { ui, calls } = mount();
  try {
    await press(ui, '\u001b[B'); await press(ui, '2');
    await press(ui, '\u001b');
    assert.equal(calls.close, 0);
    // The abandoned digit never became a value, so a bare Enter just moves on.
    await press(ui, '\r');
    assert.deepEqual(calls.start, []);
    await press(ui, '\u001b');
    assert.equal(calls.close, 1);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('the form offers the way back to the record list', async () => {
  const { ui, calls } = mount();
  try {
    await press(ui, '\u001b[B'); await press(ui, '\u001b[B'); await press(ui, '\u001b[B');
    await press(ui, '\u001b[B'); await press(ui, '\u001b[B'); // ← Choose another record
    await press(ui, '\r');
    assert.equal(calls.back, 1);
    assert.deepEqual(calls.start, []);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('an erased value stays as it was instead of reading as zero', async () => {
  const { ui, frame } = mount();
  try {
    await press(ui, '\u001b[B'); // From
    await press(ui, '\x7f'); // erase the default 1
    await press(ui, '\r');
    assert.match(frame(), /From\s+1/);
    assert.doesNotMatch(frame(), /default 1/);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('a busy or offline host refuses Start but never traps the form', async () => {
  const { ui, calls, frame } = mount(false);
  try {
    await press(ui, '\r');
    assert.match(frame(), /Cannot start: the host is busy or offline/);
    assert.deepEqual(calls.start, []);
    // The form stays readable and Esc still leaves it.
    await press(ui, '\u001b[B'); await press(ui, '3');
    await press(ui, '\u001b');
    await press(ui, '\u001b');
    assert.equal(calls.close, 1);
  } finally { ui.unmount(); ui.cleanup(); }
});
