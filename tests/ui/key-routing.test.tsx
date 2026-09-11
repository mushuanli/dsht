/** Who owns ↑/↓ and Ctrl+P/N: the picker, a scrolling status panel, or the composer history.
 *
 * The same key routing has broken twice — a panel gate disabled recall for every open panel, and
 * then a status panel took the arrows even when it had nothing to scroll — so the whole matrix is
 * asserted here instead of being found by hand.
 */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { App } from '../../src/ui/app.tsx';
import { Controller } from '../../src/controller/controller.ts';
import { CostLedger } from '../../src/cost/index.ts';
import { renderAt, type TestTerminal } from '../support/tty.ts';
import { host, until } from '../support/host.ts';

const PLACEHOLDER = 'Message, @host-file, or /help';

/** Composer contents, taken between its borders so transcript rows cannot match. */
function composer(frame: string): string {
  const lines = frame.split('\n').map(line => line.replace(/\u001b\[[0-9;]*m/g, ''));
  const top = lines.findLastIndex(line => line.includes('╭'));
  const bottom = lines.findIndex((line, index) => index > top && line.includes('╰'));
  return lines.slice(top + 1, bottom).join(' ').replace(/[│]/g, '').replace(/❯/g, '').trim();
}

/** The status panel's footer, which names the visible range while the panel has one. */
function footer(frame: string): string {
  return frame.split('\n').find(line => line.includes('Status '))?.trim() ?? '';
}

/** Mount the app on a terminal of the given size, with a session whose history holds one prompt. */
async function mount(t: Parameters<typeof test>[0] extends never ? never : { after(fn: () => void | Promise<void>): void }, columns: number, rows: number) {
  const fixture = await host();
  t.after(() => fixture.close());
  // A ledger keeps the cost panel available, so its key handling is part of the matrix too.
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, new CostLedger());
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
  const frame = () => ui.lastFrame() ?? '';
  return { fixture, controller, ui: ui as TestTerminal, press, frame };
}

test('the composer recalls history when nothing else is open', async t => {
  const app = await mount(t, 100, 30);
  assert.equal(composer(app.frame()), PLACEHOLDER);
  await app.press('\u001b[A');
  await until(() => composer(app.frame()) === '你好');
});

test('a status panel that fits leaves the arrows and Ctrl+P to the composer', async t => {
  const app = await mount(t, 100, 30);
  await app.press('/status'); await app.press('\r');
  await until(() => app.frame().includes('Session s1') === true);
  assert.equal(footer(app.frame()), '', 'a fitting panel has no footer');
  await app.press('\u001b[A');
  await until(() => composer(app.frame()) === '/status');
  assert.equal(app.frame().includes('Session s1'), true, 'the panel stays open while recalling');
  await app.press('\u0010');
  await until(() => composer(app.frame()) === '你好');
});

test('a status panel that scrolls takes the arrows and still yields Ctrl+P', async t => {
  const app = await mount(t, 40, 12);
  await app.press('/status'); await app.press('\r');
  await until(() => footer(app.frame()).includes('Status 1-') === true);
  const first = footer(app.frame());
  await app.press('\u001b[B');
  await until(() => footer(app.frame()) !== first);
  assert.equal(composer(app.frame()), PLACEHOLDER, 'the panel owns the arrow');
  await app.press('\u001b[6~');
  await until(() => footer(app.frame()) !== first);
  assert.equal(composer(app.frame()), PLACEHOLDER, 'the panel owns page keys too');
  await app.press('\u0010');
  await until(() => composer(app.frame()) === '/status');
});

test('the help and cost panels do not take the arrows from the composer', async t => {
  const app = await mount(t, 100, 30);
  await app.press('/help'); await app.press('\r');
  await until(() => app.frame().includes('Enter send · Tab complete') === true);
  await app.press('\u001b[A');
  await until(() => composer(app.frame()) === '/help');
  await app.press('\u0003');
  await app.press('/cost'); await app.press('\r');
  await until(() => app.frame().includes('Cost · CNY estimate') === true);
  await app.press('\u001b[A');
  await until(() => composer(app.frame()) === '/cost');
});
