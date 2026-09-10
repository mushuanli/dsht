/** Drive the actual terminal components against the isolated HTTP host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/app.tsx';
import { Controller } from '../src/controller.ts';
import { host, until } from './host.ts';

test('startup requires workspace and session selection before showing the composer', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('Project α') === true);
  assert.match(ui.lastFrame()!, /Choose workspace/);
  ui.stdin.write('\r');
  await until(() => ui.lastFrame()?.includes('Choose session') === true);
  ui.stdin.write('\u001b[B');
  await until(() => ui.lastFrame()?.includes('❯ First conversation') === true);
  ui.stdin.write('\r');
  await until(() => ui.lastFrame()?.includes('你好') === true);
  assert.equal(controller.state.sessionId, 's1');
  assert.equal(fixture.calls.some(call => call.method === 'session/create'), false);
  ui.stdin.write('hello from terminal');
  await until(() => ui.lastFrame()?.includes('hello from terminal') === true);
  ui.stdin.write('\r');
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  fixture.follow({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  fixture.follow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 2, index: 0,
    chunk: { type: 'text-delta', index: 0, text: 'Streaming reply' } } });
  await until(() => ui.lastFrame()?.includes('Streaming reply') === true);
});
