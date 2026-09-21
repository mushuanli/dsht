/** The `/prompt` shortcut list: choose into the composer, edit through it, and delete rows. */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React, { act } from 'react';
import { App } from '../../src/ui/app.tsx';
import { Controller } from '../../src/controller/controller.ts';
import { array, object } from '../../src/transport/wire.ts';
import { renderAt } from '../support/tty.ts';
import { host, until } from '../support/host.ts';

const PLACEHOLDER = 'Message, @host-file, or /help';

/** Composer contents, taken between its borders so transcript rows cannot match. */
function composer(frame: string): string {
  const lines = frame.split('\n').map(line => line.replace(/\u001b\[[0-9;]*m/g, ''));
  const top = lines.findLastIndex(line => line.includes('╭'));
  const bottom = lines.findIndex((line, index) => index > top && line.includes('╰'));
  return lines.slice(top + 1, bottom).join(' ').replace(/[│]/g, '').replace(/❯/g, '').trim();
}

/** Mount the app on a live fixture. Without a path the two shortcuts start in memory; with one the
 *  caller owns the file, which is how the unreadable-file case is set up. */
async function mount(t: { after(fn: () => void | Promise<void>): void }, promptsPath?: string) {
  const fixture = await host();
  t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', promptsPath });
  if (promptsPath === undefined) {
    await controller.promptStore.save('Explain this code');
    await controller.promptStore.save('Review for bugs');
  }
  const ui = renderAt(<App controller={controller} />, 100, 30);
  t.after(async () => { ui.close(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready && (ui.lastFrame() ?? '').includes('你好') === true);
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
  return { fixture, controller, press, frame: () => ui.lastFrame() ?? '' };
}

test('/prompt chooses a saved prompt into the composer instead of sending it', async t => {
  const app = await mount(t);
  assert.equal(composer(app.frame()), PLACEHOLDER);
  await app.press('/prompt'); await app.press('\r');
  await until(() => app.frame().includes('Saved prompts') && app.frame().includes('Explain this code'));
  await app.press('\r');
  await until(() => composer(app.frame()) === 'Explain this code');
  // Choosing hands the text to the composer: the list closes and nothing reaches the host yet.
  assert.equal(app.frame().includes('Saved prompts'), false);
  assert.equal(app.fixture.calls.some(call => call.method === 'session/prompt'), false);
  await app.press('\r');
  await until(() => app.fixture.calls.some(call => call.method === 'session/prompt'));
  const sent = app.fixture.calls.filter(call => call.method === 'session/prompt').at(-1)!;
  assert.deepEqual(array(object(object(object(sent.payload).args).request).content), [{ type: 'text', text: 'Explain this code' }]);
});

test('/prompt e edits the saved prompt through the composer without sending', async t => {
  const app = await mount(t);
  await app.press('/prompt'); await app.press('\r');
  await until(() => app.frame().includes('Explain this code'));
  await app.press('e');
  await until(() => app.frame().includes('Editing saved prompt') && composer(app.frame()) === 'Explain this code');
  await app.press(' now');
  await app.press('\r');
  await until(() => app.controller.promptStore.list.some(item => item.text === 'Explain this code now'));
  // An edit is written back to the list, never delivered to the model.
  assert.equal(app.fixture.calls.some(call => call.method === 'session/prompt'), false);
  assert.equal(app.frame().includes('Editing saved prompt'), false);
});

test('/prompt d deletes the selected prompt', async t => {
  const app = await mount(t);
  await app.press('/prompt'); await app.press('\r');
  await until(() => app.frame().includes('Explain this code'));
  await app.press('d');
  await until(() => !app.controller.promptStore.list.some(item => item.text === 'Explain this code'));
  assert.deepEqual(app.controller.promptStore.list.map(item => item.text), ['Review for bugs']);
  assert.equal(app.frame().includes('Explain this code'), false);
});

test('/prompt TEXT saves a shortcut prompt that the list then offers', async t => {
  const app = await mount(t);
  await app.press('/prompt Fix this bug and add tests'); await app.press('\r');
  await until(() => app.controller.promptStore.list.some(item => item.text === 'Fix this bug and add tests'));
  await until(() => app.controller.queries.foreground === undefined);
  await app.press('/prompt'); await app.press('\r');
  await until(() => app.frame().includes('Fix this bug and add tests'));
});

test('/prompt Esc abandons an edit without changing the list or sending', async t => {
  const app = await mount(t);
  await app.press('/prompt'); await app.press('\r');
  await until(() => app.frame().includes('Explain this code'));
  await app.press('e');
  await until(() => app.frame().includes('Editing saved prompt') && composer(app.frame()) === 'Explain this code');
  await app.press(' changed');
  await app.press('\u001b');
  await until(() => !app.frame().includes('Editing saved prompt') && composer(app.frame()) === PLACEHOLDER);
  assert.deepEqual(app.controller.promptStore.list.map(item => item.text), ['Explain this code', 'Review for bugs']);
  assert.equal(app.fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('/prompt keeps an emptied edit in edit mode instead of saving or sending it', async t => {
  const app = await mount(t);
  await app.press('/prompt'); await app.press('\r');
  await until(() => app.frame().includes('Explain this code'));
  await app.press('e');
  await until(() => composer(app.frame()) === 'Explain this code');
  await app.press('\u0015'); // Ctrl+U clears the composer but not the edit.
  await until(() => composer(app.frame()) === PLACEHOLDER);
  await app.press('\r');
  await until(() => app.frame().includes('Type the prompt text') === true);
  assert.deepEqual(app.controller.promptStore.list.map(item => item.text), ['Explain this code', 'Review for bugs']);
  assert.equal(app.frame().includes('Editing saved prompt'), true);
});

test('/prompt reports a file it cannot read instead of failing the client', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prompts-ui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'prompts.json');
  await writeFile(path, '{ not json');
  const app = await mount(t, path);
  await app.press('/prompt'); await app.press('\r');
  await until(() => app.frame().includes('could not be read') === true);
  assert.equal(app.frame().includes('No saved prompts'), true);
});
