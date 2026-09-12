/** The composer never trades the conversation away for input, on a phone or in landscape.
 *
 * A single long logical line used to wrap until it filled the whole frame: the conversation was
 * squeezed to zero rows, the closing border left the screen, and the status bar disappeared. The
 * window is now bounded by the body height alone, so width can only reduce wrapping.
 */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { App } from '../../src/ui/app.tsx';
import { Controller } from '../../src/controller/controller.ts';
import { renderAt, type TestTerminal } from '../support/tty.ts';
import { host, until } from '../support/host.ts';

/** Rows the bordered composer occupies, including both border rows. */
function composerRows(frame: string): number {
  const lines = frame.split('\n').map(line => line.replace(/\u001b\[[0-9;]*m/g, ''));
  const top = lines.findLastIndex(line => line.includes('╭'));
  const bottom = lines.findIndex((line, index) => index > top && line.includes('╰'));
  return top < 0 || bottom < 0 ? -1 : bottom - top + 1;
}

/** Mount the app on a terminal whose size the test chooses. */
async function mount(t: { after(fn: () => void | Promise<void>): void }, columns: number, rows: number) {
  const fixture = await host();
  t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = renderAt(<App controller={controller} />, columns, rows);
  t.after(async () => { ui.close(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready && (ui.lastFrame() ?? '').includes('你好') === true);
  const press = async (value: string) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    try {
      await act(async () => {});
      await act(async () => { ui.press(value); });
      await new Promise(resolve => setTimeout(resolve, 40));
    } finally {
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  };
  return { controller, ui: ui as TestTerminal, press, frame: () => ui.lastFrame() ?? '' };
}

test('a wrapped draft on a 44x16 phone keeps the conversation and the closing border', async t => {
  const app = await mount(t, 44, 16);
  await app.press('x'.repeat(500));
  await until(() => app.frame().includes('xxxx') === true);
  // body 11 rows -> content window 3 rows, so the composer owns 5 rows and leaves 6 to the reader.
  assert.equal(composerRows(app.frame()), 5, app.frame());
  assert.ok(app.frame().includes('你好'), app.frame());
  assert.ok(app.frame().includes('● Ready'), app.frame());
  await app.press('\u0003');
});

test('a short terminal spends width on wrapping, not on composer height', async t => {
  const app = await mount(t, 80, 12);
  await app.press('y'.repeat(500));
  await until(() => app.frame().includes('yyyy') === true);
  // The 70 extra columns change nothing: a body of 7 rows leaves a one-row content window.
  assert.equal(composerRows(app.frame()), 3, app.frame());
  assert.ok(app.frame().includes('你好'), app.frame());
  await app.press('\u0003');
});

test('a tall paste folds instead of pushing the conversation out', async t => {
  const app = await mount(t, 44, 16);
  const paste = ['head note', ...Array.from({ length: 6 }, (_, index) => `log line ${index}`), 'tail note'].join('\n');
  await app.press(paste);
  await until(() => app.frame().includes('head note') === true);
  const frame = app.frame();
  assert.ok(frame.includes('[6 lines · '), frame);
  assert.ok(frame.includes('tail note'), frame);
  assert.ok(!frame.includes('log line 3'), frame);
  assert.ok(frame.includes('你好'), frame);
  await app.press('\u0003');
});

test('a folded block is crossed in one step and deleted in one step', async t => {
  const app = await mount(t, 44, 16);
  // A log file normally ends in a newline, which puts the block's trailing edge at the draft end.
  await app.press('head note\n' + Array.from({ length: 6 }, (_, index) => `log line ${index}`).join('\n') + '\n');
  await until(() => app.frame().includes('head note') === true);
  assert.ok(app.frame().includes('[6 lines · '), app.frame());
  // The cursor sits directly after the hidden block, so one backspace removes all of it.
  await app.press('\u007f');
  await until(() => !app.frame().includes('[6 lines · ') === true);
  assert.ok(app.frame().includes('head note'), app.frame());
  await app.press('\u0003');
});
