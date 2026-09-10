/** Drive the actual terminal components against the isolated HTTP host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/app.tsx';
import { Controller } from '../src/controller.ts';
import { host, until } from './host.ts';

test('startup requires workspace and session selection before showing the composer', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token');
  const ui = render(<App controller={controller} />);
  // Flush React's input-listener effects before delivering the next terminal event.
  const press = async (value: string) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    try {
      await act(async () => {});
      await act(async () => { ui.stdin.write(value); });
    } finally {
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  };
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('Project α') === true);
  assert.match(ui.lastFrame()!, /Choose workspace/);
  await press('\r');
  await until(() => ui.lastFrame()?.includes('Choose session') === true);
  await press('\u001b[B');
  await until(() => ui.lastFrame()?.includes('❯ First conversation') === true);
  await press('\r');
  await until(() => ui.lastFrame()?.includes('你好') === true);
  assert.equal(controller.state.sessionId, 's1');
  assert.equal(fixture.calls.some(call => call.method === 'session/create'), false);
  await press('hello from terminal');
  await until(() => ui.lastFrame()?.includes('hello from terminal') === true);
  await press('\r');
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  fixture.follow({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  fixture.follow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 2, index: 0,
    chunk: { type: 'text-delta', index: 0, text: 'Streaming reply' } } });
  await until(() => ui.lastFrame()?.includes('Streaming reply') === true);
  await until(() => !controller.state.busy);
  await press('/workspace Project α');
  await until(() => ui.lastFrame()?.includes('/workspace Project α') === true);
  await press('\r');
  await until(() => controller.state.screen === 'sessions' && !controller.state.busy);
  await until(() => !ui.lastFrame()?.includes('/workspace Project α'));
  await press('/session s1');
  await until(() => ui.lastFrame()?.includes('/session s1') === true);
  await press('\r');
  await until(() => controller.state.screen === 'chat' && controller.state.sessionId === 's1')
    .catch(error => { throw new Error(`${error}\n${ui.lastFrame()}\n${controller.state.error}`); });
});
