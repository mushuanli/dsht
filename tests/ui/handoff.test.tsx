/** `/handoff`: the client clears its own HANDOFF.md, then the agent is asked to write a new one. */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React, { act } from 'react';
import { App } from '../../src/ui/app.tsx';
import { Controller } from '../../src/controller/controller.ts';
import { array, object } from '../../src/transport/wire.ts';
import { renderAt } from '../support/tty.ts';
import { host, until } from '../support/host.ts';

test('/handoff deletes the local HANDOFF.md before asking the agent for a new one', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const directory = await mkdtemp(join(tmpdir(), 'dsht-handoff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'HANDOFF.md');
  await writeFile(path, 'stale handoff');
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', localDirectory: directory });
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
  await press('/handoff'); await press('\r');
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  // The stale copy is gone before the turn that would rewrite it is ever sent.
  await assert.rejects(() => stat(path), /ENOENT/);
  const sent = fixture.calls.filter(call => call.method === 'session/prompt').at(-1)!;
  const content = array(object(object(object(sent.payload).args).request).content);
  const text = String(object(array(content)[0]).text);
  // The instruction names the file and the states a reader needs, and is not a normal user turn.
  assert.match(text, /HANDOFF\.md/);
  assert.match(text, /completed, still open, or impossible/);
  assert.match(text, /next steps/i);
  await until(() => (ui.lastFrame() ?? '').includes('Handoff requested') === true);
});
