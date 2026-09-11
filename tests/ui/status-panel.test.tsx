/** The expanded `/status` panel: narrow terminals wrap every value and page what still does not fit. */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { Controller } from '../../src/controller/controller.ts';
import { CostLedger, costRecords } from '../../src/cost/index.ts';
import { StatusBar } from '../../src/ui/chat/status.tsx';
import { App } from '../../src/ui/app.tsx';
import { renderAt } from '../support/tty.ts';
import { host, until } from '../support/host.ts';

const LONG_PATH = '/home/li/share/prj/deepseek-harness/packages/experimental/very-long-directory-name/sub';

/** A controller with every optional detail row filled in, without contacting a host. */
function panelController(): Controller {
  const ledger = new CostLedger();
  const controller = new Controller('http://127.0.0.1:1234', 'test-token', 's1', undefined, undefined, ledger);
  controller.state = {
    ...controller.state, sessionId: 's1', workspaceId: 'w1', online: true,
    status: 'connected to a host whose status string is quite long indeed',
    controlError: 'session/follow rejected: remote error 429 too many requests, retry after 30 seconds',
    presetError: 'preset catalog unavailable because the host returned an unexpected payload',
    modelError: 'model catalog unavailable: connection reset by peer while listing providers',
    workspaces: [{ workspaceId: 'w1', title: 'Project α with a long workspace title', path: LONG_PATH, sessionIds: ['s1'] }],
  };
  return controller;
}

/** Strip box drawing, page footers and whitespace, so an assertion survives any wrap position. */
function flat(frame: string): string {
  return frame.split('\n').filter(line => !line.includes('PgUp/PgDn pages')).join('\n').replace(/[\s│┌┐└┘─]/gu, '');
}

test('a narrow panel wraps long values instead of truncating them', () => {
  const controller = panelController();
  for (const width of [44, 32, 24]) {
    const ui = render(<Box width={width}><StatusBar controller={controller} expanded width={width} /></Box>);
    const frame = ui.lastFrame()!;
    ui.unmount(); ui.cleanup();
    assert.doesNotMatch(frame, /…/u, `width ${width} truncated a value`);
    assert.ok(flat(frame).includes(flat(LONG_PATH)), `width ${width} lost part of the workspace path`);
    assert.ok(flat(frame).includes(flat('connected to a host whose status string is quite long indeed')), `width ${width} lost part of the host status`);
  }
});

test('every detail line survives paging, and the footer names the pages', () => {
  const controller = panelController();
  const page = (index: number) => {
    const ui = render(<Box width={44}><StatusBar controller={controller} expanded width={44} page={index} pageSize={6} /></Box>);
    const frame = ui.lastFrame()!;
    ui.unmount(); ui.cleanup();
    return frame;
  };
  const first = page(0);
  const total = Number(/Status 1\/(\d+)/.exec(first)?.[1]);
  assert.ok(total > 1, `expected more than one page, got:\n${first}`);
  const frames = Array.from({ length: total }, (_, index) => page(index));
  for (const [index, frame] of frames.entries()) {
    assert.match(frame, new RegExp(`Status ${index + 1}/${total} · PgUp/PgDn pages`));
    assert.doesNotMatch(frame, /…/u);
  }
  // Content is compared without whitespace, because a page break can fall inside any phrase.
  const union = flat(frames.join('\n'));
  for (const detail of ['● Ready · Ctrl+C exit', 'Host: http://127.0.0.1:1234', 'Session ID: s1', 'Workspace: Project α with a long workspace title',
    `Model:`, 'Context:', 'In (uncached):', 'Cost (CNY estimate):', 'Turns:', 'Queued:',
    'session/follow rejected: remote error 429 too many requests, retry after 30 seconds',
    'Preset names unavailable: preset catalog unavailable because the host returned an unexpected payload',
    'Model catalog unavailable: model catalog unavailable: connection reset by peer while listing providers']) {
    assert.ok(union.includes(flat(detail)), `paging dropped ${detail}`);
  }
  // A page past the last one stays on the last one instead of rendering nothing.
  assert.equal(page(99), frames.at(-1));
});

test('PgUp and PgDn page the open panel through the running application', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.baseline = [{ workspaceId: 'w1', title: 'Project α', path: LONG_PATH, sessionIds: ['s1'] }];
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  // Twelve rows leave one content row per page, so the footer alone proves the key reached the panel.
  const ui = renderAt(<App controller={controller} />, 40, 12);
  t.after(async () => { ui.close(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready && controller.state.screen === 'chat');
  const press = async (value: string) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    try { await act(async () => {}); await act(async () => { ui.press(value); }); } finally {
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  };
  assert.equal(ui.lastFrame()?.includes('Status 1/'), false);
  await press('/status'); await press('\r');
  await until(() => ui.lastFrame()?.includes('Status 1/') === true);
  const first = ui.lastFrame()!;
  await press('\u001b[6~');
  await until(() => ui.lastFrame()?.includes('Status 2/') === true);
  assert.notEqual(ui.lastFrame(), first);
  await press('\u001b[5~');
  await until(() => ui.lastFrame()?.includes('Status 1/') === true);
  // Reopening starts at the first page rather than the page that was left behind.
  await press('\u001b[6~');
  await until(() => ui.lastFrame()?.includes('Status 2/') === true);
  await press('\u001b');
  await until(() => ui.lastFrame()?.includes('Status 2/') === false);
  await press('/status'); await press('\r');
  await until(() => ui.lastFrame()?.includes('Status 1/') === true);
  await press('\u001b');
});
