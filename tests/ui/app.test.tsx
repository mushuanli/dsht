/** Drive the actual terminal components against the isolated HTTP host. */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React, { act, useEffect } from 'react';
import { render } from 'ink-testing-library';
import { App } from '../../src/ui/app.tsx';
import { COMMAND_HINTS, commonPrefix } from '../../src/slash/registry.ts';
import { Controller } from '../../src/controller/controller.ts';
import type { VerifierPort } from '../../src/controller/verifier.ts';
import { CostLedger } from '../../src/cost/ledger.ts';
import { array, object, type ObjectValue } from '../../src/transport/wire.ts';
import { controlFrame } from '../../src/transport/events.ts';
import { host, snapshot, until } from '../support/host.ts';
import { renderAt } from '../support/tty.ts';
import { StatusBar } from '../../src/ui/chat/status.tsx';
import { statusSource } from '../support/status-source.ts';
import { readTrace } from '../../src/controller/trace-log.ts';

function assertInsideComposer(frame: string, label: string) {
  const lines = frame.split('\n');
  const option = lines.findIndex(line => line.includes(label));
  const input = lines.findIndex(line => line.includes('❯ Message, @host-file, or /help'));
  const top = lines.findIndex(line => line.includes('╭'));
  const bottom = lines.findIndex(line => line.includes('╰'));
  assert.ok(top >= 0 && top < option && option < bottom, frame);
  assert.ok(top < input && input < bottom, frame);
  assert.equal(lines.filter(line => line.includes('╭')).length, 1, frame);
}

test('startup status refreshes after connection and reconnect while copy mode retains its frame', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  assert.match(ui.lastFrame()!, /Connecting…/);
  assert.match(ui.lastFrame()!, /Offline/);
  await pressKey(ui, '\u0013');
  const frozen = ui.lastFrame();
  controller.start();
  await until(() => controller.state.online && controller.state.workspaces.length > 0);
  assert.equal(ui.lastFrame(), frozen);
  await pressKey(ui, '\u001b');
  await until(() => ui.lastFrame()?.includes('Choose workspace') === true);
  const connected = async () => {
    await until(() => controller.state.online && !ui.lastFrame()?.includes('Offline') && !ui.lastFrame()?.includes('Connecting…'));
    assert.match(ui.lastFrame()!, /● Ready/);
  };
  await connected();
  for (const screen of ['workspaces', 'sessions', 'path']) {
    if (screen === 'path') {
      controller.actions.enterPath();
      await until(() => ui.lastFrame()?.includes('Absolute directory path on host') === true);
    } else if (screen === 'sessions') {
      await controller.actions.switchWorkspace('w1');
      await until(() => ui.lastFrame()?.includes('Choose session') === true);
    }
    assert.equal(controller.state.screen, screen);
    const workspaces = controller.state.workspaces;
    fixture.disconnect();
    await until(() => !controller.state.online && ui.lastFrame()?.includes('Offline') === true);
    await connected();
    await until(() => controller.state.workspaces !== workspaces);
    await until(() => controller.state.screen === (screen === 'path' ? 'workspaces' : screen));
  }
});

test('Esc leaves a picker opened over a conversation and returns to it', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  // `/resume` is a detour over the conversation, so Esc must cancel it and come back.
  await pressKey(ui, '/resume'); await pressKey(ui, '\r');
  await until(() => controller.state.screen === 'sessions' && ui.lastFrame()?.includes('Choose session') === true);
  await pressKey(ui, '\u001b');
  await until(() => controller.state.screen === 'chat' && ui.lastFrame()?.includes('你好') === true);
  // Returning does not reload or re-select: the same conversation is shown.
  assert.equal(controller.state.sessionId, 's1');
  // The workspace list opened with `/ws` behaves the same way.
  await pressKey(ui, '/ws'); await pressKey(ui, '\r');
  await until(() => controller.state.screen === 'workspaces' && ui.lastFrame()?.includes('Choose workspace') === true);
  await pressKey(ui, '\u001b');
  await until(() => controller.state.screen === 'chat' && ui.lastFrame()?.includes('你好') === true);
  assert.equal(controller.state.sessionId, 's1');
});

test('with nothing selected, Esc on the session list steps back to the workspace list', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && ui.lastFrame()?.includes('Project α') === true);
  // Picking a workspace opens its sessions; there is no conversation to return to yet.
  await pressKey(ui, '\r');
  await until(() => controller.state.screen === 'sessions' && ui.lastFrame()?.includes('Choose session') === true);
  await pressKey(ui, '\u001b');
  await until(() => controller.state.screen === 'workspaces' && ui.lastFrame()?.includes('Choose workspace') === true);
});

test('the workspace picker offers this client directory, and Esc leaves the typed-path screen', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const here = '/local/checkout';
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', localDirectory: here });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('Project α') === true);
  // The row names the directory it would register, so the common case needs no typing at all.
  await until(() => ui.lastFrame()?.includes(`+ Add workspace (this directory)  ${here}`) === true);
  // A typed host path is a screen of its own: Esc goes back to the picker instead of trapping it.
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\u001b[B'); await pressKey(ui, '\u001b[B');
  await pressKey(ui, '\r');
  await until(() => controller.state.screen === 'path' && ui.lastFrame()?.includes('Absolute directory path on host') === true);
  // A half-typed path is dropped with the screen: the picker ignores keys while a draft exists, so
  // leaving the text behind would leave the picker dead.
  await pressKey(ui, '/srv/partial');
  await pressKey(ui, '\u001b');
  await until(() => controller.state.screen === 'workspaces' && ui.lastFrame()?.includes('Choose workspace') === true);
  assert.equal(ui.lastFrame()?.includes('/srv/partial'), false);
  // Choosing the local row registers exactly the directory this client runs in.
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\u001b[B');
  await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'workspace/create') && controller.queries.foreground === undefined);
  const created = object(object(object(fixture.calls.find(call => call.method === 'workspace/create')!.payload).args).request);
  assert.equal(created.path, here);
  // Once the host reports that directory as a workspace, the row stops repeating it.
  fixture.baseline = [{ workspaceId: 'w1', title: 'Project α', path: here, sessionIds: ['s1'] }];
  await controller.actions.showPicker('workspaces');
  await until(() => ui.lastFrame()?.includes('Choose workspace') === true);
  assert.equal(ui.lastFrame()?.includes('+ Add workspace (this directory)'), false);
});

test('starting inside a registered workspace directory skips the workspace picker', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  // The ninth argument is the directory this client runs in; the fixture registers /host/project.
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', localDirectory: '/host/project' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.screen === 'sessions' && controller.state.workspaces.length > 0);
  assert.equal(controller.state.workspaceId, 'w1');
  assert.match(ui.lastFrame()!, /Choose session/);
  assert.doesNotMatch(ui.lastFrame()!, /Choose workspace/);
  assert.match(ui.lastFrame()!, /Workspace from this directory/);
});

test('an unrelated directory leaves the workspace picker in place and matching is by segment', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', localDirectory: '/srv/elsewhere' });
  t.after(() => controller.stop()); controller.start();
  await until(() => controller.state.online && controller.state.workspaces.length > 0);
  assert.equal(controller.state.screen, 'workspaces');
  // A directory inside a workspace still adopts it, but a sibling with a shared prefix does not.
  assert.equal(controller.session.adoptLocalWorkspace('/host/project/src/deep'), 'w1');
  assert.equal(controller.session.adoptLocalWorkspace('/host/project-old'), undefined);
});

test('startup requires workspace and session selection before showing the composer', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  const ui = render(<App controller={controller} />);
  const press = (value: string) => pressKey(ui, value);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('Project α') === true);
  assert.match(ui.lastFrame()!, /Choose workspace/);
  assert.doesNotMatch(ui.lastFrame()!, /Connecting…|Offline/);
  assertInsideComposer(ui.lastFrame()!, 'Choose workspace');
  await press('\r');
  await until(() => ui.lastFrame()?.includes('Choose session') === true);
  await press('\u001b[B');
  await until(() => ui.lastFrame()?.includes('❯ ● First conversation') === true);
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
  await until(() => controller.queries.foreground === undefined);
  await press('explain @');
  await until(() => ui.lastFrame()?.includes('❯ src/') === true);
  const expected = await readFile(new URL('../expected/file-references.txt', import.meta.url), 'utf8');
  for (const line of expected.trimEnd().split('\n')) assert.ok(ui.lastFrame()!.includes(line), ui.lastFrame());
  const before = fixture.calls.filter(call => call.method === 'session/prompt').length;
  await press('\t');
  await until(() => ui.lastFrame()?.includes('❯ src/hello world.ts') === true);
  await press('\r');
  await until(() => ui.lastFrame()?.includes('@"src/hello world.ts"') === true);
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, before);
  await press('please');
  await press('\r');
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === before + 1);
  const sent = fixture.calls.filter(call => call.method === 'session/prompt').at(-1)!;
  assert.deepEqual(array(object(object(object(sent.payload).args).request).content),
    [{ type: 'text', text: 'explain @"src/hello world.ts" please' }]);
  assert.equal(fixture.calls.some(call => String(call.method).includes('upload')), false);
  await until(() => controller.queries.foreground === undefined);
  await press('@missing');
  await until(() => ui.lastFrame()?.includes('No matching host files') === true);
  const cancelCount = fixture.calls.filter(call => call.method === 'session/cancel').length;
  await press('\u001b');
  await until(() => !ui.lastFrame()?.includes('Host files'));
  assert.equal(fixture.calls.filter(call => call.method === 'session/cancel').length, cancelCount);
  await press('\r');
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === before + 2);
  await until(() => controller.queries.foreground === undefined);
  await press('/ws Project α');
  await until(() => ui.lastFrame()?.includes('/ws Project α') === true);
  await press('\r');
  await until(() => controller.state.screen === 'sessions' && controller.queries.foreground === undefined);
  await until(() => !ui.lastFrame()?.includes('/ws Project α'));
  await press('/resume s1');
  await until(() => ui.lastFrame()?.includes('/resume s1') === true);
  await press('\r');
  await until(() => controller.state.screen === 'chat' && controller.state.sessionId === 's1')
    .catch(error => { throw new Error(`${error}\n${ui.lastFrame()}\n${controller.state.lastFailure}`); });
  await until(() => controller.queries.foreground === undefined);
  await press('/resume all');
  await until(() => ui.lastFrame()?.includes('/resume all') === true);
  await press('\r');
  await until(() => ui.lastFrame()?.includes('Choose session · All workspaces') === true);
  assert.equal(controller.queries.visibleSessions.length, 2);
  await until(() => controller.queries.foreground === undefined);
  await press('/ws');
  await until(() => ui.lastFrame()?.includes('❯ /ws') === true);
  await press('\r');
  await until(() => ui.lastFrame()?.includes('Choose workspace') === true);
});

// Flush React's input-listener effects before delivering the next terminal event.
async function pressKey(ui: ReturnType<typeof render>, value: string) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  try {
    await act(async () => {});
    await act(async () => { ui.stdin.write(value); });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
}

test('obsolete reference results cannot replace a newer draft and lookup errors stay in the menu', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const original = controller.queries.references.bind(controller.queries);
  let oldSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  controller.queries.references = async (query, signal) => {
    if (query !== 'old') return original(query, signal);
    oldSignal = signal;
    await delayed;
    return [{ path: 'obsolete-result.ts', kind: 'file' }];
  };
  const ui = render(<App controller={controller} />);
  t.after(async () => { release!(); ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '@old');
  await until(() => oldSignal !== undefined);
  await pressKey(ui, 'new');
  await until(() => ui.lastFrame()?.includes('❯ src/') === true);
  assert.equal(oldSignal!.aborted, true);
  release!();
  await pressKey(ui, '');
  assert.equal(ui.lastFrame()?.includes('obsolete-result.ts'), false);
  fixture.businessError = true;
  await pressKey(ui, 'x');
  await until(() => ui.lastFrame()?.includes('session/agent-busy') === true);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
  await pressKey(ui, '\u001b');
  await until(() => !ui.lastFrame()?.includes('Host files'));
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});

test('Ctrl+C clears a draft before stopping the current agent, then exits when idle', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  let exited = false;
  function MountedApp() {
    useEffect(() => () => { exited = true; }, []);
    return <App controller={controller} />;
  }
  const ui = render(<MountedApp />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.queries.running);
  await pressKey(ui, '@');
  await until(() => ui.lastFrame()?.includes('Host files') === true);
  // The open completion belongs to the draft: the first Ctrl+C discards it without stopping the turn.
  await pressKey(ui, '\u0003');
  await until(() => ui.lastFrame()?.includes('Host files') === false);
  assert.equal(exited, false);
  assert.equal(controller.queries.running, true);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
  await pressKey(ui, '\u0003');
  await until(() => fixture.calls.some(call => call.method === 'session/cancel'));
  assert.equal(exited, false);
  await until(() => controller.state.status.includes('Cancellation requested'));
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => !controller.queries.running);
  await pressKey(ui, '\u0003');
  await until(() => exited);
});

test('status bar follows host metrics, elapsed working time, cancellation and generation replacement', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.controlBaseline = { projections: { s1: { asOfSeq: 5, values: {
    modelSelection: { lastUsed: { provider: 'p', model: 'chat' }, next: { provider: 'p', model: 'chat' } },
    sessionStats: { turns: 42 },
    contextPressure: { projectedTokens: 25, contextWindow: 100 },
    tokenUsage: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 },
  } } }, queues: { s1: [1, 2].map(id => ({ id: String(id), placement: 'steering', message: { id: String(id), content: [{ type: 'text', text: `Pending ${id}` }] } })) }, jobs: { s1: [{ status: 'running' }] } };
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready && ui.lastFrame()?.includes('1K tok') === true);
  const compact = ui.lastFrame()!.split('\n').find(line => line.includes('1K tok'))!;
  // The three prompt buckets are disjoint, so the share is the cache read over all billed input.
  assert.match(compact, /● Ready │ chat · ctx: ███░░░░░░░ ~25% · 42 turns · 1K tok · hit 38%/);
  assert.equal(ui.lastFrame()?.includes('Workspace:'), false);
  assert.match(ui.lastFrame()!, /First conversation/);
  await pressKey(ui, '/status');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Context ~25% (25/100)') === true);
  for (const line of (await readFile(new URL('../expected/status-bar.txt', import.meta.url), 'utf8')).trimEnd().split('\n')) {
    assert.ok(ui.lastFrame()!.includes(line), ui.lastFrame());
  }
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => /◐ 0:0\d/.test(ui.lastFrame() ?? ''));
  fixture.control({ type: 'projection', sessionId: 's1', key: 'contextPressure', seq: 6, value: { projectedTokens: 50, contextWindow: 100 } });
  fixture.control({ type: 'queue', sessionId: 's1', items: [] });
  await until(() => controller.queries.telemetry.view('s1').queued === 0);
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Context ~50%') === true && ui.lastFrame()?.includes('Queued 0') === true);
  await pressKey(ui, '\u001b');
  await until(() => fixture.calls.some(call => call.method === 'session/cancel'));
  // Esc closed the details panel; reopen it to watch the metrics across a reconnect.
  assert.equal(ui.lastFrame()?.includes('Session s1'), false);
  await pressKey(ui, '/status');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Session s1') === true);
  fixture.controlBaseline = { projections: {}, queues: {}, jobs: {} };
  fixture.disconnect();
  await until(() => !controller.state.online);
  await until(() => controller.queries.record.ready && controller.state.online);
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Context unknown') === true);
  // The panel is open here, and its stale total is gone with the cleared projections.
  assert.equal(ui.lastFrame()?.includes('1K tok'), false);
  await pressKey(ui, '/status');
  await pressKey(ui, '\r');
  // The compact bar drops the context group entirely while the projection is missing, so nothing
  // on screen still claims the metrics the reconnect cleared. The panel render above proves the
  // frame settled, and the bar may legitimately be naming a freeze reason instead of a clock.
  assert.equal(ui.lastFrame()?.includes('ctx '), false);
  assert.equal(ui.lastFrame()?.includes('Workspace:'), false);
});

test('hosts without a control stream show unknown metrics and refresh catalog defaults on settings changes', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.controlAvailable = false;
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '/status');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Model: fixture/chat') === true);
  assert.match(ui.lastFrame()!, /Live metrics unavailable/);
  assert.match(ui.lastFrame()!, /\? tok/);
  fixture.defaultModel = { provider: 'fixture', model: 'new-default' };
  fixture.emit({ type: 'emit', event: 'settings/document-updated', args: [] });
  await until(() => controller.state.defaultModel?.model === 'new-default');
  assert.match(ui.lastFrame()!, /Model: fixture\/chat/);
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Model: fixture/new-default') === true);
  assert.equal(controller.state.online, true);
});

test('terminal control keys edit the submitted prompt and keep reference completion at the draft end', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, 'alpha beta gamma');
  for (const key of ['\u0001', '\u0006', '\u000b', '\u0019', '\u0005', '\u0017', '\u0015', '\u0019', '\u0001', '\u0004']) {
    await pressKey(ui, key);
  }
  await pressKey(ui, '\u001b[H');
  await pressKey(ui, 'A');
  await pressKey(ui, '\u001b[F');
  await pressKey(ui, 'tail');
  await pressKey(ui, '\u001bb');
  await pressKey(ui, '\u000b');
  await pressKey(ui, 'done');
  const expected = await readFile(new URL('../expected/input-edit.txt', import.meta.url), 'utf8');
  assert.ok(ui.lastFrame()!.includes(expected.trimEnd()), ui.lastFrame());
  await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const sent = fixture.calls.find(call => call.method === 'session/prompt')!;
  assert.deepEqual(object(object(object(sent.payload).args).request).content, [{ type: 'text', text: 'Alpha beta done' }]);
  await until(() => controller.queries.foreground === undefined);
  await pressKey(ui, '@');
  await until(() => ui.lastFrame()?.includes('Host files') === true);
  await pressKey(ui, '\u0001');
  await until(() => !ui.lastFrame()?.includes('Host files'));
  await pressKey(ui, '\u0005');
  await until(() => ui.lastFrame()?.includes('Host files') === true);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});

test('DEL and BS erase backward while CSI Delete erases forward', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, 'abc');
  await pressKey(ui, '\x7f');
  await pressKey(ui, '\x1b[127u');
  await pressKey(ui, 'b');
  await pressKey(ui, '\x01');
  await pressKey(ui, '\x1b[3~');
  await pressKey(ui, '\x05');
  await pressKey(ui, '\x08');
  await pressKey(ui, 'one two');
  await pressKey(ui, '\x1b\x7f');
  await pressKey(ui, 'done');
  assert.ok(ui.lastFrame()!.includes('❯ one done'), ui.lastFrame());
  await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const sent = fixture.calls.find(call => call.method === 'session/prompt')!;
  assert.deepEqual(object(object(object(sent.payload).args).request).content, [{ type: 'text', text: 'one done' }]);
});

test('typing reuses the transcript projection but a new host event invalidates it', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('你好') === true);
  const transcript = controller.queries.record;
  const project = transcript.messagesForWidth.bind(transcript);
  let reads = 0;
  transcript.messagesForWidth = width => { reads++; return project(width); };
  for (const character of 'typing') await pressKey(ui, character);
  assert.equal(reads, 0);
  fixture.follow({ type: 'event', event: { type: 'user/message', seq: 1, surfaceOp: 'append',
    data: { content: [{ type: 'text', text: 'Fresh host message' }] } } });
  await until(() => ui.lastFrame()?.includes('Fresh host message') === true);
  assert.equal(reads, 1);
  await pressKey(ui, '\x7f');
  assert.equal(reads, 1);
});

test('mouse scrolling loads history and slash search selects a matching record', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const records = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => ({
    type: 'event', event: { seq: start + index, type: 'user/message', surfaceOp: 'append',
      data: { content: [{ type: 'text', text: `history-record-${start + index}` }] } },
  }));
  fixture.followSnapshot = { type: 'snapshot', cursor: 39, hasMore: true, header: { id: 's1' }, records: records(20, 40) };
  fixture.onPage = async () => ({ records: records(0, 20), hasMore: false });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('history-record-39') === true);
  // Opening a session folds every prompt in the background; that walk is not the interaction here.
  await until(() => controller.state.session.prompts.length === 40);
  const folded = fixture.calls.filter(call => call.method === 'session/page').length;
  const press = (value: string) => pressKey(ui, value);
  await press('\x1b[<64;3;4M');
  await until(() => !ui.lastFrame()?.includes('history-record-39'));
  for (let i = 0; i < 20; i++) await press('\x1b[<64;3;4M');
  await until(() => !controller.queries.record.hasMore && controller.queries.foreground === undefined);
  assert.equal(fixture.calls.filter(call => call.method === 'session/page').length, folded + 1);
  const page = fixture.calls.filter(call => call.method === 'session/page').at(-1)!;
  assert.equal(object(object(object(page.payload).args).request).beforeSeq, 20);
  await press('\x1b[<0;3;4M');
  assert.match(ui.lastFrame()!, /Copy mode/);
  await press('\x13');
  await press('/search history-record-5'); await press('\r');
  await until(() => ui.lastFrame()?.includes('#5 You · history-record-5') === true);
  await until(() => controller.queries.foreground === undefined);
  await press('\r');
  await until(() => !ui.lastFrame()?.includes('History · your prompts') && ui.lastFrame()?.includes('history-record-5') === true);
  for (let i = 0; i < 60; i++) await press('\x1b[<65;3;4M');
  await until(() => ui.lastFrame()?.includes('history-record-39') === true && controller.queries.foreground === undefined);
  for (let i = 0; i < 60; i++) await press('\x1b[<64;3;4M');
  await until(() => ui.lastFrame()?.includes('history-record-0') === true && controller.queries.foreground === undefined);
  await press('/wsearch 你好'); await press('\r');
  await until(() => ui.lastFrame()?.includes('s2 · 你好 too') === true && controller.queries.foreground === undefined);
  await press('\x1b');
  await press('/ssearch 你好'); await press('\r');
  await until(() => ui.lastFrame()?.includes('s1 · 你好') === true && controller.queries.foreground === undefined);
  assert.equal(ui.lastFrame()?.includes('s2 · 你好 too'), false);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('a new message draft returns the view to the live end, but a slash command does not', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const records = Array.from({ length: 40 }, (_, index) => ({
    type: 'event', event: { seq: index, type: 'user/message', surfaceOp: 'append',
      data: { content: [{ type: 'text', text: `history-record-${index}` }] } },
  }));
  fixture.followSnapshot = { type: 'snapshot', cursor: 39, hasMore: false, header: { id: 's1' }, records };
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('history-record-39') === true);
  await pressKey(ui, '\u001b[<64;3;4M');
  await until(() => ui.lastFrame()?.includes('history-record-39') === false);
  // A slash command is not a message, so typing one keeps the reader where they are.
  await pressKey(ui, '/');
  assert.equal(ui.lastFrame()?.includes('history-record-39'), false);
  await pressKey(ui, '\u0003');
  await until(() => ui.lastFrame()?.includes('❯ Message, @host-file, or /help') === true);
  // Starting a message returns to the live end with the draft intact.
  await pressKey(ui, 'h');
  await until(() => ui.lastFrame()?.includes('history-record-39') === true);
  assert.match(ui.lastFrame()!, /❯ h/);
  // Once the draft exists, a reader who scrolls away keeps their place while editing it.
  await pressKey(ui, '\u001b[<64;3;4M');
  await until(() => ui.lastFrame()?.includes('history-record-39') === false);
  await pressKey(ui, 'i');
  assert.equal(ui.lastFrame()?.includes('history-record-39'), false);
  assert.match(ui.lastFrame()!, /❯ hi/);
  await pressKey(ui, '\u0003');
});

test('a status panel that fits leaves the history arrows with the composer', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready && ui.lastFrame()?.includes('你好') === true);
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Session s1') === true);
  // The compacted panel fits this terminal, so ↑ still recalls history rather than scrolling it.
  await pressKey(ui, '\u001b[A');
  await until(() => ui.lastFrame()?.includes('❯ /status') === true);
  await pressKey(ui, '\u0010');
  await until(() => ui.lastFrame()?.includes('❯ 你好') === true);
  await pressKey(ui, '\u0003');
});

test('a pasted multi-line snippet keeps its line breaks and sends its source text', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  // A phone paste arrives as one burst; line breaks and tabs survive, and a tab is displayed at its
  // tab stop without changing the character that is sent.
  await pressKey(ui, 'first line\nsecond line\twith tab');
  await until(() => ui.lastFrame()?.includes('❯ first line') === true);
  assert.ok(ui.lastFrame()!.includes('second line with tab'), ui.lastFrame());
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
  await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const sent = fixture.calls.find(call => call.method === 'session/prompt')!;
  assert.deepEqual(array(object(object(object(sent.payload).args).request).content),
    [{ type: 'text', text: 'first line\nsecond line\twith tab' }]);
  await pressKey(ui, '\u0003');
});

test('a tall pasted block folds to a summary row while the full text is still sent', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  const paste = ['head note', ...Array.from({ length: 6 }, (_, index) => `log line ${index}`), 'tail note'].join('\n');
  await pressKey(ui, paste);
  await until(() => ui.lastFrame()?.includes('❯ head note') === true);
  const frame = ui.lastFrame()!;
  assert.ok(frame.includes('[6 lines · '), frame);
  assert.ok(frame.includes('tail note'), frame);
  assert.ok(!frame.includes('log line 3'), frame);
  await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const sent = fixture.calls.find(call => call.method === 'session/prompt')!;
  assert.deepEqual(array(object(object(object(sent.payload).args).request).content),
    [{ type: 'text', text: paste }]);
  await pressKey(ui, '\u0003');
});

test('search loads old messages, opens cross-session matches and cancels local paging', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 10, hasMore: true, header: { id: 's1' }, records: [
    { type: 'event', event: { seq: 10, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'recent' }] } } },
  ] };
  fixture.onPage = async () => ({ records: [
    { type: 'event', event: { seq: 0, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'needle in old history' }] } } },
  ], hasMore: false });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  let release: (() => void) | undefined;
  t.after(async () => { release?.(); ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  const press = (value: string) => pressKey(ui, value);
  await press('/search needle'); await press('\r');
  await until(() => ui.lastFrame()?.includes('#0 You · needle in old history') === true && controller.queries.foreground === undefined);
  const expected = await readFile(new URL('../expected/history-navigation.txt', import.meta.url), 'utf8');
  for (const line of expected.trimEnd().split('\n')) assert.ok(ui.lastFrame()!.includes(line), ui.lastFrame());
  await press('\r');
  await until(() => !ui.lastFrame()?.includes('Search · session history') && controller.queries.foreground === undefined);
  fixture.searchResult = { items: [{ sessionId: 's2', snippet: 'needle' }], hasMore: false };
  await press('/wsearch needle'); await press('\r');
  await until(() => ui.lastFrame()?.includes('s2 · needle') === true && controller.queries.foreground === undefined);
  await press('\r');
  await until(() => controller.state.sessionId === 's2' && ui.lastFrame()?.includes('#0 You · needle in old history') === true && controller.queries.foreground === undefined);
  await press('\x1b');
  await controller.actions.selectSession('s1');
  await until(() => controller.queries.record.ready);
  const cancelCount = fixture.calls.filter(call => call.method === 'session/cancel').length;
  let requested = false;
  fixture.onPage = async () => { requested = true; await new Promise<void>(resolve => { release = resolve; }); return { records: [], hasMore: false }; };
  await press('/search absent'); await press('\r');
  await until(() => requested);
  await press('\x1b');
  await until(() => controller.queries.foreground === undefined);
  assert.equal(fixture.calls.filter(call => call.method === 'session/cancel').length, cancelCount);
  assert.equal(controller.queries.record.hasMore, true);
  release!();
});

test('/cost displays cached session and daily estimates without submitting a prompt', async t => {
  const { CostLedger, costRecords } = await import('../../src/cost/index.ts');
  const fixture = await host(); t.after(() => fixture.close());
  const ledger = new CostLedger();
  const recording = (await readFile(new URL('../fixtures/workspace-edit.session.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => object(JSON.parse(line)));
  await ledger.replace('s1', recording.length - 2, costRecords(recording.slice(1).map((event, seq) => ({ type: 'event', event: { ...event, seq } }))));
  // Retain the recorded usage while this test exercises the terminal command.
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', costs: ledger });
  controller.actions.refreshCosts = async () => false;
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, '/cost'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Cost · CNY estimate') === true);
  const expected = await readFile(new URL('../expected/cost.txt', import.meta.url), 'utf8');
  for (const line of expected.trimEnd().split('\n')) assert.ok(ui.lastFrame()?.includes(line), ui.lastFrame());
  // The open panel pauses the clock, and the bar names that reason instead of freezing silently.
  assert.match(ui.lastFrame()!, /⏸ dialog │ chat · ¥: 0\.00\(0\.00\)\*/);
  assert.equal(fixture.calls.some(c => c.method === 'session/prompt'), false);
});

test('header follows session titles and Esc cancels despite a stale idle flag, retaining the acknowledgement', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  let release: (() => void) | undefined;
  fixture.onCancel = () => new Promise<void>(resolve => { release = resolve; });
  const ui = render(<App controller={controller} />);
  t.after(async () => { release?.(); ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('First conversation') === true);
  fixture.control({ type: 'projection', sessionId: 's1', key: 'title', seq: 1, value: { title: 'Readable session title' } });
  await until(() => ui.lastFrame()?.includes('Readable session title') === true);
  assert.equal(controller.queries.running, false);
  await pressKey(ui, '\x1b');
  await until(() => release !== undefined);
  await pressKey(ui, '\x1b');
  assert.equal(fixture.calls.filter(call => call.method === 'session/cancel').length, 1);
  release!();
  await until(() => ui.lastFrame()?.includes('Cancellation requested · waiting for host') === true);
  fixture.follow({ type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'Late history event' }] } } });
  await until(() => ui.lastFrame()?.includes('Late history event') === true);
  assert.match(ui.lastFrame()!, /Cancellation requested · waiting for host/);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => controller.state.status === 'Idle');
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Session s1') === true);
  fixture.onCancel = undefined;
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.queries.running);
  await pressKey(ui, '@');
  await until(() => ui.lastFrame()?.includes('Host files') === true);
  await pressKey(ui, '\x1b');
  await until(() => fixture.calls.filter(call => call.method === 'session/cancel').length === 2);
  assert.equal(ui.lastFrame()?.includes('Host files'), false);
});

test('quitting cancels the selected running turn before the client closes', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  let exited = false;
  function MountedApp() {
    useEffect(() => () => { exited = true; }, []);
    return <App controller={controller} />;
  }
  const ui = render(<MountedApp />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.queries.running);
  await pressKey(ui, '/quit'); await pressKey(ui, '\r');
  await until(() => exited);
  // Unmounting alone leaves host work running; the lifetime around the render cancels it.
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
  await controller.shutdown();
  assert.equal(fixture.calls.filter(call => call.method === 'session/cancel').length, 1);
});

test('closing an idle client sends no cancellation', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  controller.start();
  await until(() => controller.queries.record.ready);
  await controller.shutdown();
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});

test('/think lists prompt summaries, expands the selected thought, and supports folding it again', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  const thinking = `Considering the request ${'in detail '.repeat(12)}closing detail`;
  fixture.follow({ type: 'event', event: { type: 'assistant/message', seq: 1, surfaceOp: 'append',
    data: { message: { content: [{ type: 'reasoning', text: thinking }, { type: 'text', text: 'Answer' }] } } } });
  await until(() => ui.lastFrame()?.includes('Answer') === true);
  assert.equal(ui.lastFrame()?.includes('closing detail'), false);
  await pressKey(ui, '/think'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Reasoning history · User prompts') === true);
  assert.ok(ui.lastFrame()?.includes('#1 User · 你好'));
  assert.equal(fixture.calls.some(call => call.method === 'session/page'), false);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Reasoning history · User prompts') === false && ui.lastFrame()?.includes('closing detail') === true);
  await pressKey(ui, '/think 1'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('closing detail') === false);
  assert.equal(ui.lastFrame()?.includes('closing detail'), false);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('a rejected line keeps its draft while an accepted one clears the composer', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  // An unknown command is a result, not a thrown fault: the reason is shown and the line stays, which
  // is the `retain` half of the result contract.
  await pressKey(ui, '/nope'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Unknown command. Use /help.') === true);
  assert.match(ui.lastFrame()!, /❯ \/nope/);
  // A line the application used up clears the composer: `consume`.
  await pressKey(ui, '\u0015');
  await pressKey(ui, '/loop stop'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('No loop is running') === true);
  assert.match(ui.lastFrame()!, /❯ Message, @host-file, or \/help/);
});

test('a slash-command panel stays open for reading and closes on another command', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} panelLifetimeMs={150} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  Object.defineProperty(ui.stdout, 'rows', { value: 60, configurable: true });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('/ws [name or ID]') === true);
  // Every advertised command shows its one-line description.
  const helpFrame = ui.lastFrame()!;
  for (const hint of COMMAND_HINTS) {
    assert.ok(helpFrame.includes(hint.command) && helpFrame.includes(hint.description), `${hint.command}: ${helpFrame}`);
  }
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Session s1') === true);
  // The next command replaced the previous panel.
  assert.equal(ui.lastFrame()!.includes('/ws [name or ID]'), false);
  // Background timers do not dismiss a panel while the user is reading or copying.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.match(ui.lastFrame()!, /Session s1/);
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Session s1') === false);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('Esc closes an open command panel and keeps the draft beside it', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('/ws [name or ID]') === true);
  await pressKey(ui, 'plain draft');
  await until(() => ui.lastFrame()?.includes('plain draft') === true);
  await pressKey(ui, '\u001b');
  await until(() => ui.lastFrame()?.includes('/ws [name or ID]') === false);
  assert.equal(ui.lastFrame()?.includes('plain draft'), true);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});

test('/history expires on its own and closes immediately on Esc', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} panelLifetimeMs={150} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '/history'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('History · loaded records') === true);
  // A forgotten lookup releases the composer without another keystroke.
  await until(() => ui.lastFrame()?.includes('History · loaded records') === false, 2000);
  await pressKey(ui, '/history'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('History · loaded records') === true);
  await pressKey(ui, '\u001b');
  await until(() => ui.lastFrame()?.includes('History · loaded records') === false);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('cost coverage marks the subtotals it cannot confirm instead of rewriting them', async t => {
  const { CostLedger, costRecords } = await import('../../src/cost/index.ts');
  const fixture = await host(); t.after(() => fixture.close());
  const ledger = new CostLedger();
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', costs: ledger });
  controller.state = { ...controller.state, sessionId: 's1', online: true };
  const bar = (expanded = false) => {
    const ui = render(<StatusBar source={statusSource(controller)} expanded={expanded} />);
    const frame = ui.lastFrame() ?? '';
    ui.unmount(); ui.cleanup();
    return frame;
  };
  // A session the ledger has not priced reads as unknown inside the pair, and the parenthesized
  // figure is the day's, so neither can be mistaken for the other.
  assert.match(bar(), /● Ready/);
  assert.match(bar(), /● Ready │ ¥: \?\(0\.00\)\*/);
  await ledger.replace('s1', 1, costRecords([{ type: 'event', event: { seq: 0, time: Date.parse('2026-09-10T10:00:00+08:00'),
    type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } } }]));
  // Charges cached by an earlier run already cover the history, so the bar stops warning.
  const cached = bar();
  assert.match(cached, /¥: 2\.00\(0\.00\)(?!\*)/);
  assert.match(bar(true), /Cost ~¥2\.0000 session/);
  // A freshly opened session reports its own zero in the pair, never the day's spend as its own cost.
  controller.state = { ...controller.state, sessionId: 's2' };
  assert.match(bar(), /● Ready │ ¥: \?\(0\.00\)/);
  await ledger.replace('s2', 1, []);
  assert.match(bar(), /● Ready │ ¥: 0\.00\(0\.00\)/);
  controller.state = { ...controller.state, sessionId: 's1' };
  ledger.error = 'scan failed';
  assert.match(bar(), /¥: 2\.00\(0\.00\)\*/);
  assert.match(bar(true), /Cost coverage incomplete: scan failed/);
});

test('the bar names the tool that is running, including while the clock is paused', async t => {
  const controller = new Controller({ base: 'http://x1:4096' });
  const now = Date.now();
  controller.state = { ...controller.state, online: true, status: 'Connected', sessionId: 's1', screen: 'chat',
    sessions: [{ sessionId: 's1', running: true }] };
  controller.queries.record.addPage({ hasMore: false, records: [
    { type: 'event', event: { seq: 0, type: 'turn/start', time: now - 8_000, data: { turn: 1 } } },
    { type: 'event', event: { seq: 1, time: now - 5_000, surfaceOp: 'append', type: 'assistant/message',
      data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } } } },
  ] });
  const bar = (pauseReason?: 'copy' | 'dialog' | 'history') => {
    const ui = render(<StatusBar source={statusSource(controller)} pauseReason={pauseReason} />);
    const frame = ui.lastFrame() ?? '';
    ui.unmount(); ui.cleanup();
    return frame;
  };
  // The tool runs after the assistant stream that asked for it ended, so the bar reads the open turn.
  assert.match(bar(), /◐ 0:0\d · bash \d+s · \^C/, bar());
  // A paused bar keeps the phase: the reason explains the frozen clock, and the running tool is the
  // answer the bar exists to give.
  for (const reason of ['copy', 'dialog', 'history'] as const) {
    const frame = bar(reason);
    assert.match(frame, new RegExp(`⏸ ${reason} 0:0\\d · bash \\d+s`), frame);
  }
  // The result arriving does not clear the phase: the bar times the current event until a newer one
  // starts, so the quiet stretch after a command is still time the turn spent working.
  controller.queries.record.addPage({ hasMore: false, records: [
    { type: 'event', event: { seq: 2, time: now - 1_000, surfaceOp: 'append', type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: false }] } } } },
  ] });
  assert.match(bar(), /◐ 0:0\d · bash \d+s · \^C/, bar());
  // A ready bar has no phase at all: the transcript keeps the last event it saw, and only the host
  // knows that the turn ended.
  controller.state = { ...controller.state, sessions: [{ sessionId: 's1', running: false }] };
  const ready = bar();
  assert.match(ready, /● Ready/);
  assert.equal(ready.includes('bash'), false);
});

test('an idle bar re-reads the clock so the day subtotal rolls over at midnight', async t => {
  const { CostLedger, costRecords } = await import('../../src/cost/index.ts');
  const fixture = await host(); t.after(() => fixture.close());
  const ledger = new CostLedger();
  await ledger.replace('s1', 1, costRecords([{ type: 'event', event: { seq: 0, time: Date.parse('2026-09-10T23:00:00+08:00'),
    type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } } }]), Date.parse('2026-09-10T23:59:30+08:00'));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', costs: ledger });
  controller.state = { ...controller.state, sessionId: 's1', online: true };
  // A model makes the row wide enough to carry the day total beside the session slice.
  controller.queries.telemetry.accept(controlFrame({ type: 'baseline', value: { projections: { s1: { asOfSeq: 0, values: {
    modelSelection: { lastUsed: { provider: 'p', model: 'deepseek-flash' } } } } }, queues: {}, jobs: {} } }));
  // Nothing else touches the bar, so only the bar's own timer can move the calendar day it reports.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-09-10T23:59:30+08:00') });
  const ui = render(<StatusBar source={statusSource(controller)} />);
  t.after(() => { ui.unmount(); ui.cleanup(); });
  // The pair carries the session cost and the day's, so the row answers both scopes at once.
  assert.match(ui.lastFrame()!, /flash · ¥: 1\.00\(1\.00\)/, ui.lastFrame());
  t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  // The calendar day moved with nothing else happening, so only the parenthesized figure changes.
  assert.match(ui.lastFrame()!, /flash · ¥: 1\.00\(0\.00\)/, ui.lastFrame());
});

test('the pickers show each session state and a workspace rollup from the list summary', async t => {
  const controller = new Controller({ base: 'http://x1:4096' });
  const now = Date.now();
  controller.state = { ...controller.state, online: true, status: 'Connected', screen: 'workspaces',
    workspaces: [{ workspaceId: 'w1', title: 'Project α', path: '/host/project', sessionIds: ['s1', 's2', 's3'] }],
    sessions: [
      { sessionId: 's1', updatedAt: now - 5 * 60_000, projections: { values: { title: 'Idle one' } } },
      { sessionId: 's2', running: true, updatedAt: now - 2 * 60_000, projections: { values: { title: 'Running one' } } },
      { sessionId: 's3', blank: true, projections: { values: { title: 'Blank one' } } },
    ] };
  let ui!: ReturnType<typeof render>;
  await act(async () => { ui = render(<App controller={controller} />); });
  t.after(() => { ui.unmount(); ui.cleanup(); });
  // The workspace row spells the states out in attention order, drops the blank session entirely, and
  // keeps the path in its own right-aligned column beside the title.
  assert.match(ui.lastFrame()!, /❯ Project α\s+◐ 1 working · ● 1 ready\s+\/host\/project/, ui.lastFrame());
  // An unanswered approval is the state the user has to act on, so it leads the rollup.
  await act(async () => { controller.session.accept({ kind: 'approval-request', eventId: 'a1', sessionId: 's1', description: 'Confirm' }); });
  assert.match(ui.lastFrame()!, /\? 1 needs you · ◐ 1 working/, ui.lastFrame());
  controller.state = { ...controller.state, screen: 'sessions', workspaceId: 'w1', showAllSessions: false };
  await act(async () => { ui.rerender(<App controller={controller} />); });
  const frame = ui.lastFrame()!;
  // The session rows read the same three states with the same markers, so the list needs one key only.
  assert.match(frame, /◐ 2m Running one  s2/, frame);
  assert.match(frame, /\? 5m Idle one  s1/, frame);
  assert.match(frame, /○ Blank one  s3/, frame);
});

test('the bar names an answer the user still owes ahead of the running clock', () => {
  const controller = new Controller({ base: 'http://x1:4096' });
  controller.state = { ...controller.state, online: true, status: 'Connected', sessionId: 's1', screen: 'chat',
    sessions: [{ sessionId: 's1', running: true }],
    pending: [{ kind: 'approval', eventId: 'a1', sessionId: 's1', description: 'Confirm' }] };
  const ui = render(<StatusBar source={statusSource(controller)} pauseReason="dialog" />);
  const frame = ui.lastFrame()!;
  ui.unmount(); ui.cleanup();
  // The paused reason only explains the frozen clock; the owed answer is what the user has to act on.
  assert.match(frame, /\? Needs you/, frame);
  assert.equal(frame.includes('⏸ dialog'), false, frame);
});

test('a narrow workspace picker keeps the markers and spells them out once', async t => {
  const controller = new Controller({ base: 'http://x1:4096' });
  controller.state = { ...controller.state, online: true, status: 'Connected', screen: 'workspaces',
    workspaces: [{ workspaceId: 'w1', title: 'Project α', path: '/host/project', sessionIds: ['s1', 's2'] }],
    sessions: [{ sessionId: 's1', running: true }, { sessionId: 's2', blank: true }] };
  // 46 columns leave the list inside the composer frame too narrow for words but roomy enough for a key.
  const ui = renderAt(<App controller={controller} />, 46, 24);
  t.after(() => ui.close());
  const frame = ui.lastFrame()!;
  assert.match(frame, /● ready · ◐ working · \? needs you/, frame);
  assert.match(frame, /❯ Project α\s+◐1/, frame);
  // The path column is the first thing to go, because the title is what the row is for.
  assert.equal(frame.includes('/host/project'), false, frame);
});

test('Tab completes a slash command and stops at an ambiguous shared prefix', async t => {
  assert.equal(commonPrefix(['/ws', '/wsearch']), '/ws');
  assert.equal(commonPrefix(['/help']), '/help');
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '/w'); await pressKey(ui, '\t');
  await until(() => ui.lastFrame()?.includes('❯ /ws') === true);
  await pressKey(ui, '\u0015');
  await pressKey(ui, '/he'); await pressKey(ui, '\t');
  await until(() => ui.lastFrame()?.includes('❯ /help') === true);
});

test('title and status fit terminal widths and keep model alignment when working completes', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  const controller = new Controller({ base: 'http://x1:4096' });
  controller.state = { ...controller.state, online: true, status: 'Connected', sessionId: 's1', screen: 'chat',
    sessions: [{ sessionId: 's1', running: true }], workspaceId: 'w1',
    workspaces: [{ workspaceId: 'w1', title: 'Workspace 示例', path: '/workspace' }] };
  controller.queries.record.addPage({ records: [{ type: 'event', event: { seq: 0, type: 'turn/start', time: Date.now() - 8000, data: { turn: 42 } } }], hasMore: false });
  controller.queries.telemetry.accept(controlFrame({ type: 'baseline', value: { projections: { s1: { asOfSeq: 0, values: {
    title: { title: '中文会话标题'.repeat(20) },
    modelSelection: { next: { provider: 'p', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } },
    sessionStats: { turns: 42 }, contextPressure: { projectedTokens: 25, contextWindow: 100 },
    tokenUsage: { uncachedInputTokens: 166_200_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } } }, queues: {}, jobs: {} } }));
  let ui!: ReturnType<typeof render>;
  await act(async () => { ui = render(<App controller={controller} />); });
  t.after(() => { ui.unmount(); ui.cleanup(); });
  let columns = 140;
  Object.defineProperty(ui.stdout, 'columns', { get: () => columns });
  const refresh = async () => { await act(async () => { ui.rerender(<App controller={controller} />); }); };
  await refresh();
  assert.match(ui.lastFrame()!.split('\n')[0]!, /^\s*中文会话标题/);
  const working = ui.lastFrame()!.split('\n').find(line => line.includes('◐ '))!;
  assert.match(working, /◐ 0:0\d · \^C │ v4\.1-flash · high · ctx: ███░░░░░░░ ~25% · 42 turns · 166\.2M tok/);
  controller.state = { ...controller.state, version: 1, sessions: [{ sessionId: 's1', running: false }] };
  await refresh();
  const ready = ui.lastFrame()!.split('\n').find(line => line.includes('● Ready'))!;
  assert.match(ready, /● Ready │ v4\.1-flash · high · ctx: ███░░░░░░░ ~25% · 42 turns · 166\.2M tok/);
  assert.doesNotMatch(ready, /\^C/);
  for (columns of [80, 40, 24, 12]) {
    await refresh();
    const lines = ui.lastFrame()!.split('\n');
    assert.match(lines[0]!, /^\s*中文会话/);
    assert.doesNotMatch(lines[0]!, /dsht|x1|Connected|Offline/);
    if (columns < 62) assert.doesNotMatch(lines[0]!, /Workspace/);
    assert.equal(lines[1]!.trim(), '─'.repeat(Math.max(10, columns - 2)));
  }
});

test('/think loads older summaries on demand and can open reasoning from the active attempt', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 5, hasMore: true, assistantStream: { revision: 0 }, records: [
    { type: 'event', event: { seq: 5, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'Current prompt' }] } } },
  ] };
  fixture.onPage = async (): Promise<ObjectValue> => ({ hasMore: false, records: [
    { type: 'event', event: { seq: 0, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'Older prompt' }] } } },
    { type: 'event', event: { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'reasoning', text: 'Older thought detail' }] } } } },
  ] });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  // The open-time prompt backfill walks the history once and is not the interaction under test.
  await until(() => controller.state.session.prompts.length === 2);
  const folded = fixture.calls.filter(call => call.method === 'session/page').length;
  await pressKey(ui, '/think'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('No reasoning in loaded history') === true);
  assert.equal(fixture.calls.filter(call => call.method === 'session/page').length, folded);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('#1 User · Older prompt') === true);
  assert.equal(fixture.calls.filter(call => call.method === 'session/page').length, folded + 1);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Reasoning history · User prompts') === false);
  assert.ok(ui.lastFrame()?.includes('Older thought detail'));
  fixture.follow({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  fixture.follow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', index: 0, revision: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'Current thought detail' } } });
  fixture.follow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', index: 1, revision: 3, chunk: { type: 'text-delta', index: 1, text: 'Answer' } } });
  await until(() => controller.queries.record.liveParts(80).length === 2);
  await pressKey(ui, '/think'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Now · User · Current prompt') === true);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Reasoning history · User prompts') === false);
  assert.ok(ui.lastFrame()?.includes('Current thought detail'));
});

test('long conversations keep the header visible and show keyboard help only when requested', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  fixture.follow({ type: 'event', event: { seq: 10, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: Array.from({ length: 100 }, (_, i) => `Response line ${i}`).join('\n') }] } } } });
  await until(() => ui.lastFrame()?.includes('Response line 99') === true);
  const header = ui.lastFrame()!.split('\n')[0]!;
  assert.match(header, /First conversation/);
  assert.ok(ui.lastFrame()!.split('\n').length <= 30);
  assert.ok(!ui.lastFrame()?.includes('Enter send · Tab complete'));
  await pressKey(ui, '\x1b[5~');
  await until(() => ui.lastFrame()?.includes('Response line 99') === false);
  assert.equal(ui.lastFrame()!.split('\n')[0], header);
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Enter send · Tab complete') === true);
  assert.equal(ui.lastFrame()!.split('\n')[0], header);
});

test('search opens an isolated old page and /latest returns to new live messages', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 50, hasMore: true, assistantStream: { revision: 0 }, records: [
    { type: 'event', event: { seq: 50, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'Recent prompt' }] } } },
  ] };
  fixture.onPage = async (): Promise<ObjectValue> => ({ records: [
    { type: 'event', event: { seq: 0, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'needle from an older page' }] } } },
  ], hasMore: false });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  const live = controller.queries.record;
  await pressKey(ui, '/search needle'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('#0 You · needle from an older page') === true);
  assert.equal(live.retainedRecordCount, 1);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Earlier history · /latest') === true);
  fixture.follow({ type: 'event', event: { seq: 51, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'New live answer' }] } } } });
  await until(() => live.messages.some(message => message.seq === 51));
  assert.ok(!ui.lastFrame()?.includes('New live answer'));
  await pressKey(ui, '/latest'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('New live answer') === true);
  assert.ok(!ui.lastFrame()?.includes('Earlier history · /latest'));
  assert.equal(controller.queries.record, live);
});


test('/model uses the host catalog and exact model/effort selection API', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.modelCatalog = { routableProviders: ['route'], failures: [{ id: 'broken', name: 'Broken provider', message: 'offline' }], groups: [
    { id: 'route', name: 'Provider', models: [{ id: 'model-x', name: 'Model X', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } }] },
  ] };
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '/model'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Choose model') === true);
  assertInsideComposer(ui.lastFrame()!, 'Choose model');
  assert.match(ui.lastFrame()!, /Broken provider: offline/);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Choose reasoning effort') === true);
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'session/selectModel'));
  const request = object(object(object(fixture.calls.find(call => call.method === 'session/selectModel')!.payload).args).request);
  assert.deepEqual({ ...request }, { sessionId: 's1', provider: 'route', model: 'model-x', reasoningEffort: 'high' });
  await until(() => controller.queries.foreground === undefined);
  fixture.control({ type: 'projection', sessionId: 's1', key: 'modelSelection', seq: 2, value: { lastUsed: null, next: { provider: 'route', model: 'model-x', reasoningEffort: 'high' } } });
  await until(() => ui.lastFrame()?.includes('model-x · high') === true);
  fixture.presets = [...['standard', 'ptc', 'minimal', 'cordis'].map(id => ({ id, trust: 'system' })),
    { id: 'custom', trust: 'user', name: 'My review mode' }];
  let seq = 3;
  for (const [id, name] of [['standard', 'Standard mode'], ['ptc', 'PTC mode'], ['minimal', 'Minimal mode'], ['cordis', 'Creator mode'], ['custom', 'My review mode'], ['missing', 'missing']]) {
    fixture.control({ type: 'projection', sessionId: 's1', key: 'agentPreset', seq: seq++, value: id! });
    await until(() => ui.lastFrame()?.split('\n')[0]?.includes(name!) === true);
  }
  assert.equal(fixture.calls.filter(call => call.method === 'agentPresets/list').length, 1);
  fixture.control({ type: 'projection', sessionId: 's1', key: 'plan', seq: 10, value: { active: true, pending: false } });
  assert.doesNotMatch(ui.lastFrame()!.split('\n')[0]!, /Plan|Execute/);
  fixture.businessError = true;
  assert.equal(await controller.actions.selectModel('route', 'missing'), false);
  assert.match(controller.state.lastFailure, /busy/);
  assert.equal(object(controller.queries.telemetry.view('s1').values.modelSelection).next !== null, true);
  fixture.businessError = false;
  fixture.modelCatalog = { routableProviders: ['route'], failures: [], groups: [
    { id: 'route', name: 'Provider', models: [{ id: 'plain', name: 'Plain' }] },
  ] };
  await pressKey(ui, '/model'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Choose model') === true);
  await pressKey(ui, '\r');
  await until(() => fixture.calls.filter(call => call.method === 'session/selectModel').length === 3);
  assert.deepEqual({ ...object(object(object(fixture.calls.filter(call => call.method === 'session/selectModel').at(-1)!.payload).args).request) },
    { sessionId: 's1', provider: 'route', model: 'plain' });
  await until(() => controller.queries.foreground === undefined);
  await pressKey(ui, '/model route model-x high'); await pressKey(ui, '\r');
  await until(() => fixture.calls.filter(call => call.method === 'session/selectModel').length === 4);
});


test('workspace removal and session archival require confirmation and preserve host history', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  const command = async (value: string) => { await pressKey(ui, value); await pressKey(ui, '\r'); await until(() => controller.queries.foreground === undefined); };
  await command('/ws');
  await pressKey(ui, '\x7f');
  assert.doesNotMatch(ui.lastFrame()!, /Remove workspace registration/);
  await pressKey(ui, 'd');
  await until(() => ui.lastFrame()?.includes('Remove workspace registration?') === true);
  assert.doesNotMatch(ui.lastFrame()!, /❯ d/);
  await pressKey(ui, '\x1b');
  await pressKey(ui, '/d');
  assert.doesNotMatch(ui.lastFrame()!, /Remove workspace registration/);
  await pressKey(ui, '\x03');
  await pressKey(ui, '\u001b[3~');
  await until(() => ui.lastFrame()?.includes('Remove workspace registration?') === true);
  assert.match(ui.lastFrame()!, /ID: w1/);
  assert.match(ui.lastFrame()!, /Directory and sessions are kept/);
  await pressKey(ui, '\r'); // Cancel is the default choice.
  assert.equal(fixture.calls.some(call => call.method === 'workspace/delete'), false);
  await command('/resume --delete s1');
  await until(() => ui.lastFrame()?.includes('Archive session?') === true);
  assert.equal(fixture.calls.some(call => call.method === 'workspace/archiveSession'), false);
  const old = controller.queries.record;
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'workspace/archiveSession') && controller.queries.foreground === undefined);
  assert.equal(controller.queries.visibleSessions.some(row => row.sessionId === 's1'), false);
  assert.equal(old.retainedRecordCount, 0);
  await command('/resume all');
  assert.equal(controller.queries.visibleSessions.some(row => row.sessionId === 's1'), false);
  await command('/resume s1');
  await until(() => controller.queries.record.ready);
  assert.equal(controller.state.sessionId, 's1');
  await command('/ws --delete w1');
  await until(() => ui.lastFrame()?.includes('Remove workspace registration?') === true);
  fixture.businessError = true;
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\r');
  await until(() => controller.queries.foreground === undefined && controller.state.lastFailure.includes('busy'));
  assert.equal(controller.state.workspaces.length, 1);
  assert.match(ui.lastFrame()!, /Remove workspace registration/);
  fixture.businessError = false;
  await pressKey(ui, '\r');
  await until(() => controller.state.workspaces.length === 0 && controller.queries.foreground === undefined);
  assert.equal(controller.state.sessionId, 's1');
  assert.equal(controller.queries.record.ready, true);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});


test('empty sessions archive without confirmation after a fresh blank-state check', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.blank = true;
  fixture.followSnapshot = { type: 'snapshot', cursor: 0, hasMore: false, header: { id: 's1' }, records: [], assistantStream: { revision: 0 } };
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, '/resume'); await pressKey(ui, '\r');
  await until(() => controller.state.screen === 'sessions' && controller.queries.foreground === undefined);
  await pressKey(ui, '\u001b[B'); // Skip New session.
  fixture.blank = false; // The picker is stale; the removal read must observe this change.
  await pressKey(ui, 'd');
  await until(() => ui.lastFrame()?.includes('Archive session?') === true);
  assert.equal(fixture.calls.some(call => call.method === 'workspace/archiveSession'), false);
  await pressKey(ui, '\x1b');
  fixture.blank = true;
  await pressKey(ui, '/resume --delete s1'); await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'workspace/archiveSession') && controller.queries.foreground === undefined);
  assert.doesNotMatch(ui.lastFrame()!, /Archive session\?/);
  assert.equal(controller.queries.visibleSessions.some(row => row.sessionId === 's1'), false);
});


test('copy mode freezes streaming and clocks; dialogs freeze their background until closed', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => /◐ 0:0\d/.test(ui.lastFrame() ?? ''));
  await pressKey(ui, '/copy'); await pressKey(ui, '\r');
  // Copy mode names itself in the bar, because the clock it freezes would otherwise look stalled.
  await until(() => ui.lastFrame()?.includes('⏸ copy') === true);
  const frozen = ui.lastFrame();
  fixture.follow({ type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'Arrived during copy' }] } } });
  await until(() => controller.queries.record.messages.some(message => message.text.includes('Arrived during copy')));
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(ui.lastFrame(), frozen);
  await pressKey(ui, '\x1b');
  await until(() => ui.lastFrame()?.includes('Arrived during copy') === true);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
  await pressKey(ui, '/model'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Choose model') === true);
  const dialog = ui.lastFrame();
  fixture.control({ type: 'projection', sessionId: 's1', key: 'title', seq: 3, value: 'Background title changed' });
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(ui.lastFrame(), dialog);
  await pressKey(ui, '\x1b');
  await until(() => ui.lastFrame()?.includes('Background title changed') === true);
});

test('question options support numbers, arrows, multi-selection and numeric custom answers', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.replayInteractions = [{ type: 'waterfall', event: 'user-questions/request', eventId: 'choices', agentId: 's1', request: { questions: [
    { id: 'one', header: 'Destination', question: 'Choose a target', options: [{ label: 'First', description: 'First description' }, { label: 'Second' }] },
    { id: 'many', question: 'Choose features', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
    { id: 'custom', question: 'Choose a count', options: [{ label: 'Default' }] },
  ] } }];
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => ui.lastFrame()?.includes('Choose a target') === true);
  assert.match(ui.lastFrame()!, /Question 1\/3 · Destination/);
  assert.match(ui.lastFrame()!, /First description/);
  assertInsideComposer(ui.lastFrame()!, 'First description');
  await pressKey(ui, '2');
  assert.match(ui.lastFrame()!, /❯ 2\. Second/);
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Choose features') === true);
  await pressKey(ui, '1');
  await pressKey(ui, '\u001b[B'); await pressKey(ui, ' ');
  assert.match(ui.lastFrame()!, /1\. \[x\] A/);
  assert.match(ui.lastFrame()!, /2\. \[x\] B/);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Choose a count') === true);
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Esc returns to options') === true);
  await pressKey(ui, '2'); await pressKey(ui, '0'); await pressKey(ui, '2'); await pressKey(ui, '6');
  fixture.businessError = true;
  await pressKey(ui, '\r');
  await until(() => controller.state.lastFailure.includes('busy') && controller.queries.foreground === undefined);
  assert.match(ui.lastFrame()!, /2026/);
  assert.equal(controller.state.pending.length, 1);
  fixture.businessError = false;
  await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0);
  const reply = object(object(fixture.calls.filter(call => call.method === '$events/result').at(-1)!.payload).args);
  assert.deepEqual(object(reply.outcome).value, { answers: [
    { id: 'one', selected: ['Second'] }, { id: 'many', selected: ['A', 'B'] }, { id: 'custom', selected: [], custom: '2026' },
  ] });
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt' || call.method === 'session/cancel'), false);
});

test('Escape dismisses the whole question set as a rejection, discarding partial answers', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.replayInteractions = [{ type: 'waterfall', event: 'user-questions/request', eventId: 'dismiss-me', agentId: 's1', request: { questions: [
    { id: 'one', header: 'Destination', question: 'Choose a target', options: [{ label: 'First' }, { label: 'Second' }] },
    { id: 'two', question: 'And then?', options: [{ label: 'Third' }] },
  ] } }];
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => ui.lastFrame()?.includes('Choose a target') === true);
  // The first question is answered locally, so the dismissal has partial state to throw away.
  await pressKey(ui, '1');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('And then?') === true);
  assert.match(ui.lastFrame()!, /Esc dismisses/);
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
  await pressKey(ui, '\u001b');
  await until(() => controller.state.pending.length === 0);
  const reply = object(object(fixture.calls.filter(call => call.method === '$events/result').at(-1)!.payload).args);
  assert.equal(reply.eventId, 'dismiss-me');
  assert.deepEqual(object(reply.outcome), { kind: 'rejected', error: {
    name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED',
  } });
  // Dismissal is not a turn cancellation, and the dialog is gone from the frame.
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
  assert.doesNotMatch(ui.lastFrame()!, /And then\?|Choose a target/);
});

test('Escape steps out of the free-text row before it dismisses the question', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.replayInteractions = [{ type: 'waterfall', event: 'user-questions/request', eventId: 'two-step', agentId: 's1', request: { questions: [
    { id: 'only', question: 'Pick one', options: [{ label: 'Default' }] },
  ] } }];
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => ui.lastFrame()?.includes('Pick one') === true);
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Esc returns to options') === true);
  // The first Escape only leaves the custom row; the request stays pending and nothing is sent.
  await pressKey(ui, '\u001b');
  await until(() => ui.lastFrame()?.includes('Enter confirm') === true);
  assert.equal(controller.state.pending.length, 1);
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
  // The second Escape dismisses the set, exactly like the close button on the Web client.
  await pressKey(ui, '\u001b');
  await until(() => controller.state.pending.length === 0);
  const reply = object(object(fixture.calls.filter(call => call.method === '$events/result').at(-1)!.payload).args);
  assert.deepEqual(object(reply.outcome), { kind: 'rejected', error: {
    name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED',
  } });
});

test('approval Escape still keeps the request pending', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.replayInteractions = [{ type: 'waterfall', event: 'approval/request', eventId: 'keep-me', agentId: 's1', request: { reason: 'Needs a decision' } }];
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => ui.lastFrame()?.includes('Needs a decision') === true);
  await pressKey(ui, '\u001b[B');
  assert.match(ui.lastFrame()!, /❯ 1\. Allow once/);
  await pressKey(ui, '\u001b');
  assert.match(ui.lastFrame()!, /Esc keeps this pending/);
  assert.equal(controller.state.pending.length, 1);
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
});

test('advancing questions preserves every option label beside descriptions in a long session', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 49, hasMore: false, header: { id: 's1' }, assistantStream: { revision: 0 },
    records: Array.from({ length: 50 }, (_, seq) => ({ type: 'event', event: { seq, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: seq === 49 ? 'Recent decision context' : `Old prompt ${seq} ${'history '.repeat(30)}` }] } } })) };
  fixture.replayInteractions = [{ type: 'waterfall', event: 'user-questions/request', eventId: 'two-decisions', agentId: 's1', request: { questions: [
    { id: 'first', question: 'Commit locally?', options: [{ label: 'Commit' }, { label: 'Wait' }] },
    { id: 'second', header: 'After commit', question: 'After committing, how far should I go? (currently local only, version 0.2.2)', options: [
      { label: 'Push only', description: 'Pushes da0e395 to origin/main without triggering npm publish.' },
      { label: 'Publish release', description: 'Tag v0.2.2 triggers publish.yml and publishes to npm. Irreversible.' },
      { label: 'Keep local', description: 'Keep the commit local until you confirm.' },
    ] },
  ] } }];
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  Object.defineProperty(ui.stdout, 'columns', { value: 180, configurable: true });
  Object.defineProperty(ui.stdout, 'rows', { value: 28, configurable: true });
  controller.start(); await until(() => controller.queries.record.ready && ui.lastFrame()?.includes('Commit locally?') === true);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('After committing, how far') === true);
  const frame = ui.lastFrame()!;
  for (const text of ['Recent decision context', 'Question 2/2 · After commit', '❯ 1. Push only', '2. Publish release', '3. Keep local', '4. Other answer', 'Irreversible.']) {
    assert.ok(frame.includes(text), `${text}\n${frame}`);
  }
  await pressKey(ui, '\u001b[B');
  assert.match(ui.lastFrame()!, /❯ 2\. Publish release/);
  Object.defineProperty(ui.stdout, 'rows', { value: 20, configurable: true });
  ui.rerender(<App controller={controller} />);
  await pressKey(ui, '\u001b[B');
  assert.match(ui.lastFrame()!, /❯ 3\. Keep local/);
  assert.match(ui.lastFrame()!, /Recent decision context/);
  assert.match(ui.lastFrame()!, /Enter confirm/);
  await pressKey(ui, '\u001b[B');
  assert.match(ui.lastFrame()!, /❯ 4\. Other answer/);
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
});

test('composer recalls submitted prompts and commands while preserving its unsent draft', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  for (const text of ['first prompt', 'second prompt']) {
    await pressKey(ui, text); await pressKey(ui, '\r');
    await until(() => controller.queries.foreground === undefined);
  }
  await pressKey(ui, 'unfinished draft');
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ second prompt/);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ first prompt/);
  await pressKey(ui, '\u001b[B'); assert.match(ui.lastFrame()!, /❯ second prompt/);
  await pressKey(ui, '\u001b[B'); assert.match(ui.lastFrame()!, /❯ unfinished draft/);
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 2);
  await pressKey(ui, '\x03');
  await pressKey(ui, '/latest'); await pressKey(ui, '\r');
  await until(() => controller.queries.foreground === undefined);
  await pressKey(ui, '\x10'); assert.match(ui.lastFrame()!, /❯ \/latest/);
  await pressKey(ui, '\x0e'); assert.doesNotMatch(ui.lastFrame()!, /❯ \/latest/);
  await pressKey(ui, '\u001b[A'); await pressKey(ui, ' edited');
  await pressKey(ui, '\u001b[B'); assert.match(ui.lastFrame()!, /❯ \/latest edited/);
});


test('recall reaches prompts from before the seeded window with no extra request', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const prompts = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => ({
    type: 'event', event: { seq: start + index, type: 'user/message', surfaceOp: 'append', data: {
      content: [{ type: 'text', text: `prompt-${start + index}` }] } },
  }));
  fixture.followSnapshot = { type: 'snapshot', cursor: 3, hasMore: true, header: { id: 's1' }, records: prompts(2, 4) };
  fixture.onPage = async () => ({ records: prompts(0, 2), hasMore: false });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  // Opening the session folds the page before the window in the background; that walk is the only
  // read here, so the arrows must reach prompt-0 without asking the host for anything.
  await until(() => controller.state.session.prompts.length === 4);
  const pages = fixture.calls.filter(call => call.method === 'session/page');
  assert.equal(pages.length, 1, 'the open-time backfill read the page before the window');
  const request = object(object(object(pages[0]!.payload).args).request);
  assert.equal(request.beforeSeq, 2);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ prompt-3/);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ prompt-2/);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ prompt-1/);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ prompt-0/);
  // The session's oldest prompt is the end of recall: no further page is requested.
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ prompt-0/);
  assert.equal(fixture.calls.filter(call => call.method === 'session/page').length, pages.length);
  assert.doesNotMatch(ui.lastFrame()!, /Loading older prompts/);
});


test('recall recovers prompts a scroll already loaded without paging again', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const prompts = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => ({
    type: 'event', event: { seq: start + index, type: 'user/message', surfaceOp: 'append', data: {
      content: [{ type: 'text', text: `prompt-${start + index}` }] } },
  }));
  fixture.followSnapshot = { type: 'snapshot', cursor: 3, hasMore: true, header: { id: 's1' }, records: prompts(2, 4) };
  fixture.onPage = async () => ({ records: prompts(0, 2), hasMore: false });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  // Scrolling to the top loads the page before the window; those prompts are now in memory.
  for (let step = 0; step < 20; step++) await pressKey(ui, '\x1b[<64;3;4M');
  await until(() => !controller.queries.record.hasMore && controller.queries.foreground === undefined);
  // Opening the session also starts a background prompt backfill, which may consume this same page,
  // so the total is one or two rather than exactly one; twenty wheel events must not fetch twenty.
  const pagesAfterScroll = fixture.calls.filter(call => call.method === 'session/page').length;
  assert.ok(pagesAfterScroll <= 2, `expected at most the one older page, got ${pagesAfterScroll}`);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ prompt-3/);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ prompt-2/);
  // prompt-2 is the recall index's oldest entry, but prompt-1 is already loaded: refill, do not page.
  await pressKey(ui, '\u001b[A');
  await until(() => ui.lastFrame()?.includes('❯ prompt-1') === true);
  assert.equal(fixture.calls.filter(call => call.method === 'session/page').length, pagesAfterScroll);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ prompt-0/);
  assert.equal(fixture.calls.filter(call => call.method === 'session/page').length, pagesAfterScroll);
});


test('a draft belongs to its session and does not follow into the next one', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, 'draft for s1');
  assert.match(ui.lastFrame()!, /❯ draft for s1/);
  await controller.actions.selectSession('s2');
  await until(() => controller.state.sessionId === 's2' && controller.queries.record.ready && controller.queries.foreground === undefined);
  // The draft is component state scoped to the screen, so it never reaches the next session.
  assert.doesNotMatch(ui.lastFrame()!, /draft for s1/);
});


test('switching sessions releases the reading view, including a detached history window', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const records = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => ({
    type: 'event', event: { seq: start + index, type: 'user/message', surfaceOp: 'append',
      data: { content: [{ type: 'text', text: `history-record-${start + index}` }] } },
  }));
  fixture.followSnapshot = { type: 'snapshot', cursor: 39, hasMore: true, header: { id: 's1' }, records: records(20, 40) };
  fixture.onPage = async () => ({ records: records(0, 20), hasMore: false });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('history-record-39') === true);
  // Jump to a record the loaded window does not hold: that opens a detached window of its own.
  await pressKey(ui, '/search history-record-5'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('#5 You · history-record-5') === true);
  await until(() => controller.queries.foreground === undefined);
  await pressKey(ui, '\r');
  await until(() => controller.queries.window !== undefined);
  const window = controller.queries.window!;
  assert.equal(window.ready, true, 'the jump opened a detached window');
  assert.equal(controller.queries.record.messages.some(message => message.seq === 5), false,
    'the target is not loaded, so the jump had to build a detached window');
  await controller.actions.selectSession('s2');
  await until(() => controller.state.sessionId === 's2' && controller.queries.record.ready && controller.queries.foreground === undefined);
  assert.equal(controller.queries.window, undefined);
  assert.equal(window.ready, false, 'the detached window was disposed, not leaked');
});


test('answers and menu highlights belong to their session', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  // The `@` menu is component focus: it opens and highlights a row without touching session state.
  await pressKey(ui, '@');
  await until(() => ui.lastFrame()?.includes('❯ src/') === true);
  await pressKey(ui, '\u001b[B');
  // A partly answered question and an approval highlight are session-owned, so a switch clears them.
  controller.actions.setAnswers({ e1: [{ id: 'q', selected: ['a'] }] });
  controller.actions.setOption({ key: 'e1:0', cursor: 2, selected: ['a'], custom: false });
  controller.actions.setApproval({ eventId: 'e1', index: 1 });
  await controller.actions.selectSession('s2');
  await until(() => controller.state.sessionId === 's2' && controller.queries.record.ready && controller.queries.foreground === undefined);
  assert.deepEqual(controller.queries.interaction.answers, {});
  assert.equal(controller.queries.interaction.option, undefined);
  assert.equal(controller.queries.interaction.approval, undefined);
  assert.equal(ui.lastFrame()?.includes('❯ src/'), false, 'the menu did not follow the reader');
});


test('the record belongs to its session and the previous one is disposed', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  const first = controller.queries.record;
  assert.equal(first, controller.state.session.record, 'the record has exactly one owner');
  await controller.actions.selectSession('s2');
  await until(() => controller.state.sessionId === 's2' && controller.queries.record.ready && controller.queries.foreground === undefined);
  assert.notEqual(controller.queries.record, first, 'a new session gets a new record');
  assert.equal(first.ready, false, 'the previous record was disposed, not leaked');
});


test('open panels belong to their session and clear on a switch', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  // `/queue` opens a real panel; it is component state, so it exists only in this screen.
  await pressKey(ui, '/queue'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Pending input') === true);
  // `/think` and `/model` open the other panels; each belongs to the screen, not to the session.
  await pressKey(ui, '/think'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Back to conversation') === true);
  await controller.actions.selectSession('s2');
  await until(() => controller.state.sessionId === 's2' && controller.queries.record.ready && controller.queries.foreground === undefined);
  assert.doesNotMatch(ui.lastFrame()!, /Pending input/, 'the panel did not follow the reader');
  assert.doesNotMatch(ui.lastFrame()!, /Back to conversation/, 'the reasoning panel did not follow the reader');
});


test('opening a session folds every user prompt from the whole history', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const records = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => ({
    type: 'event', event: { seq: start + index, type: 'user/message', surfaceOp: 'append',
      data: { content: [{ type: 'text', text: `prompt-${start + index}` }] } },
  }));
  fixture.followSnapshot = { type: 'snapshot', cursor: 7, hasMore: true, header: { id: 's1' }, records: records(6, 8) };
  const pages = [{ records: records(4, 6), hasMore: true }, { records: records(2, 4), hasMore: true }, { records: records(0, 2), hasMore: false }];
  let page = 0;
  fixture.onPage = async () => pages[Math.min(page++, pages.length - 1)]!;
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  // Session start only delivers the newest window; the open-time backfill folds the rest.
  await until(() => controller.state.session.prompts.length === 8);
  assert.deepEqual(controller.state.session.prompts.items.map(entry => entry.text),
    ['prompt-0', 'prompt-1', 'prompt-2', 'prompt-3', 'prompt-4', 'prompt-5', 'prompt-6', 'prompt-7']);
  const folded = fixture.calls.filter(call => call.method === 'session/page').length;
  for (let step = 0; step < 8; step++) await pressKey(ui, '\u001b[A');
  assert.match(ui.lastFrame()!, /❯ prompt-0/);
  assert.equal(controller.queries.recallAtOldest, true);
  // The walk reached the host's beginning, so one more press reports the end instead of paging.
  await pressKey(ui, '\u001b[A');
  assert.match(ui.lastFrame()!, /❯ prompt-0/);
  assert.equal(fixture.calls.filter(call => call.method === 'session/page').length, folded);
});


test('a local ! command runs on this machine and prints inline', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, '! echo hello-local'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('hello-local') === true);
  assert.match(ui.lastFrame()!, /! echo hello-local/);
  await until(() => controller.shell.runs[0]?.status === 'exited');
  assert.equal(controller.shell.runs[0]!.code, 0);
  // A local command never reaches the host or the model.
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('a local ! block stays where it happened instead of pinning to the bottom', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, '! echo blocked-here'); await pressKey(ui, '\r');
  await until(() => controller.shell.runs[0]?.status === 'exited');
  // A message that arrives afterwards belongs below the block, not above it.
  fixture.follow({ type: 'event', event: { type: 'assistant/message', seq: 1, surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: 'reply after the command' }] } } } });
  await until(() => ui.lastFrame()?.includes('reply after the command') === true);
  const frame = ui.lastFrame()!;
  assert.ok(frame.includes('! echo blocked-here'));
  assert.ok(frame.indexOf('! echo blocked-here') < frame.indexOf('reply after the command'),
    'the block stays above the message that followed it');
});

test('Esc stops a running local command without interrupting the agent', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, '! sleep 30'); await pressKey(ui, '\r');
  await until(() => controller.shell.running);
  await pressKey(ui, '\u001b');
  await until(() => controller.shell.runs[0]?.status === 'exited');
  assert.notEqual(controller.shell.runs[0]!.code, 0, 'the command did not exit cleanly');
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false,
    'stopping a local command does not cancel the agent turn');
});

test('shell commands can be turned off for this client', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', shellEnabled: false });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, '! echo nope'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('disabled') === true);
  assert.equal(controller.shell.runs.length, 0);
});

test('a cost scan warms the prompt cache, so opening that session does not re-walk it', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const records = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => ({
    type: 'event', event: { seq: start + index, type: 'user/message', surfaceOp: 'append',
      data: { content: [{ type: 'text', text: `prompt-${start + index}` }] } },
  }));
  fixture.followSnapshot = { type: 'snapshot', cursor: 7, hasMore: true, header: { id: 's1' }, records: records(6, 8) };
  const pages = [{ records: records(4, 6), hasMore: true }, { records: records(2, 4), hasMore: true }, { records: records(0, 2), hasMore: false }];
  let page = 0;
  fixture.onPage = async () => pages[Math.min(page++, pages.length - 1)]!;
  // No initial session: the billing scan reads history first, then the session is opened by hand.
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', costs: new CostLedger() });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.online);
  await controller.actions.refreshCosts();
  const walked = fixture.calls.filter(call => call.method === 'session/page').length;
  assert.ok(walked > 0, 'the scan read history');
  await controller.actions.selectSession('s1');
  await until(() => controller.state.session.prompts.length === 8);
  assert.equal(fixture.calls.filter(call => call.method === 'session/page').length, walked,
    'opening the session reused the prompts the scan had already read');
});


test('restored session prompts are available before any new submission', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { ...snapshot, records: [
    ...snapshot.records,
    { type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: {
      content: [{ type: 'text', text: 'latest saved prompt' }] } } },
    { type: 'event', event: { seq: 2, type: 'user/message', surfaceOp: 'append', data: {
      source: { kind: 'system' }, content: [{ type: 'text', text: 'injected context' }] } } },
  ] };
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, 'unsent draft');
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ latest saved prompt/);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ 你好/);
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\u001b[B');
  assert.match(ui.lastFrame()!, /❯ unsent draft/);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});


test('left click freezes the display for native selection until explicit resume', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => /◐ 0:0\d/.test(ui.lastFrame() ?? ''));
  for (const report of ['\x1b[<2;3;4M', '\x1b[<0;3;4m', '\x1b[<32;3;4M']) {
    await pressKey(ui, report); assert.doesNotMatch(ui.lastFrame()!, /Copy mode/);
  }
  await pressKey(ui, '\x1b[<0;3;4M');
  assert.match(ui.lastFrame()!, /Copy mode/);
  await until(() => ui.lastFrame()?.includes('⏸ copy') === true);
  const frozen = ui.lastFrame();
  fixture.follow({ type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text: 'Received while selecting' }] } } });
  await until(() => controller.queries.record.messages.some(message => message.text.includes('Received while selecting')));
  await pressKey(ui, '\x1b[<0;3;4m');
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(ui.lastFrame(), frozen);
  await pressKey(ui, '\x03');
  await until(() => ui.lastFrame()?.includes('Received while selecting') === true);
  assert.doesNotMatch(ui.lastFrame()!, /Copy mode/);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});

test('a line in flight refuses a second line, slash command or prompt alike', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  // Hold a real effectful line open: `/compact` owns the execution slot until the host answers.
  let complete!: (value: ObjectValue) => void;
  fixture.onCommand = () => new Promise(resolve => { complete = resolve; });
  await pressKey(ui, '/compact'); await pressKey(ui, '\r');
  await until(() => controller.queries.foreground !== undefined && !!complete);
  // D1 keeps the composer editable, so each attempt is written and then refused on Enter; the draft
  // survives the refusal, which is why the operator clears it before writing the next one.
  await pressKey(ui, '\u0015');
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
  assert.equal(ui.lastFrame()?.includes('/ws [name or ID]'), false);
  assert.match(ui.lastFrame()!, /❯ \/help/);
  await pressKey(ui, '\u0015');
  await pressKey(ui, 'hello there'); await pressKey(ui, '\r');
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
  assert.match(ui.lastFrame()!, /❯ hello there/);
  await pressKey(ui, '\u0015');
  // Finishing the first line frees the slot, and the same command now runs.
  complete({ commandId: 'c1', result: { kind: 'success', text: 'Compacted 8 history items.' } });
  await until(() => controller.queries.foreground === undefined);
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('/ws [name or ID]') === true);
});

test('/compact displays host progress and outcomes without sending a prompt', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  let complete!: (value: ObjectValue) => void;
  fixture.onCommand = () => new Promise(resolve => { complete = resolve; });
  await pressKey(ui, '/compact'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Compacting history…') === true && !!complete);
  complete({ commandId: 'c1', result: { kind: 'success', text: 'Compacted 8 history items (~1200 tokens).' } });
  await until(() => controller.queries.foreground === undefined && ui.lastFrame()?.includes('Compacted 8 history items') === true);
  assert.doesNotMatch(ui.lastFrame()!, /❯ \/compact/);
  fixture.onCommand = async () => ({ commandId: 'c2', result: { kind: 'error', text: 'Compaction is unavailable: agent is not idle.' } });
  await pressKey(ui, '/compact'); await pressKey(ui, '\r');
  await until(() => controller.queries.foreground === undefined && controller.state.lastFailure.includes('not idle'));
  assert.match(ui.lastFrame()!, /❯ \/compact/);
  fixture.onCommand = async () => undefined;
  await pressKey(ui, '\r');
  await until(() => controller.state.lastFailure.includes('does not provide /compact'));
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('Esc cancels the compact request and retains the command draft', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  let complete!: (value: ObjectValue) => void;
  fixture.onCommand = () => new Promise(resolve => { complete = resolve; });
  t.after(async () => { complete?.({ commandId: 'c1', result: { kind: 'error', text: 'Compaction cancelled.' } }); ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, '/compact'); await pressKey(ui, '\r');
  await until(() => !!complete && controller.queries.foreground !== undefined);
  await pressKey(ui, '\u001b');
  await until(() => controller.queries.foreground === undefined);
  assert.match(ui.lastFrame()!, /❯ \/compact/);
  assert.doesNotMatch(ui.lastFrame()!, /Compacting history…/);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});

test('the composer stays editable during a long operation and never sends on its own', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  let complete!: (value: ObjectValue) => void;
  fixture.onCommand = () => new Promise(resolve => { complete = resolve; });
  t.after(async () => { complete?.({ commandId: 'c1', result: { kind: 'success', text: 'Compacted.' } }); ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, '/compact'); await pressKey(ui, '\r');
  await until(() => !!complete && controller.queries.foreground !== undefined);
  // D1: the next line can be written while the operation runs, and Enter refuses to send it. The
  // finished line's own draft is still there, so the operator clears it and writes the next one.
  await pressKey(ui, '\u0015');
  await pressKey(ui, 'next question while busy');
  await until(() => ui.lastFrame()?.includes('next question while busy') === true);
  await pressKey(ui, '\r');
  // The refusal is authorize's, so it comes with a reason instead of the line vanishing: the operator
  // learns that an operation owns the client, and the draft is theirs to keep.
  await until(() => ui.lastFrame()?.includes('Wait for the running operation to finish') === true);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
  assert.match(ui.lastFrame()!, /❯ next question while busy/);
  // Finishing the operation does not submit the draft either: only the operator can.
  complete({ commandId: 'c1', result: { kind: 'success', text: 'Compacted.' } });
  await until(() => controller.queries.foreground === undefined);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
  assert.match(ui.lastFrame()!, /❯ next question while busy/);
});

test('narrow terminals fold streaming reasoning until /think live opens it', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  Object.defineProperty(ui.stdout, 'columns', { value: 40, configurable: true });
  controller.start(); await until(() => controller.queries.record.ready);
  fixture.follow({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'narrow', revision: 1 } });
  fixture.follow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'narrow', revision: 2, index: 0,
    chunk: { type: 'reasoning-delta', index: 0, text: 'Thinking\nhidden reasoning detail' } } });
  await until(() => ui.lastFrame()?.includes('/think live') === true);
  assert.doesNotMatch(ui.lastFrame()!, /hidden reasoning detail/);
  await pressKey(ui, '/think live'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('hidden reasoning detail') === true);
  await pressKey(ui, '/think live'); await pressKey(ui, '\r');
  await until(() => !ui.lastFrame()?.includes('hidden reasoning detail'));
});

test('host slash commands execute directly and preserve error drafts', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.onCommand = async line => ({ commandId: 'command-1', result: { kind: 'success', text: `Completed ${line}` } });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.queries.running);
  for (const line of ['/plan outline this change', '/plan off', '/goal finish the task', '/goal pause', '/goal resume', '/permission workspace-write', '/feedback useful result']) {
    await pressKey(ui, line); await pressKey(ui, '\r');
    await until(() => controller.queries.foreground === undefined && ui.lastFrame()?.includes(`Completed ${line}`) === true);
    assert.equal(object(object(fixture.calls.filter(call => call.method === 'commands/execute').at(-1)!.payload).args).line, line);
  }
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
  fixture.onCommand = async () => ({ commandId: 'command-2', result: { kind: 'error', text: 'Unknown permission preset' } });
  await pressKey(ui, '/permission nope'); await pressKey(ui, '\r');
  await until(() => controller.state.lastFailure.includes('Unknown permission preset'));
  assert.match(ui.lastFrame()!, /❯ \/permission nope/);
  assert.ok(!COMMAND_HINTS.some(hint => hint.command === '/steer'));
});

test('working input automatically steers, stays inside the composer, and can be removed', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, 'start this task'); await pressKey(ui, '\r');
  await until(() => controller.queries.foreground === undefined);
  fixture.queuePrompts = true;
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.queries.running);
  for (const text of ['also check tests', 'skip the build']) {
    await pressKey(ui, text); await pressKey(ui, '\r');
    await until(() => controller.queries.foreground === undefined && controller.queries.telemetry.pending('s1').some(item => item.text === text));
  }
  const modes = fixture.calls.filter(call => call.method === 'session/prompt').map(call => object(object(object(call.payload).args).request).mode);
  assert.deepEqual(modes, ['queue', 'steer', 'steer']);
  assertInsideComposer(ui.lastFrame()!, 'also check tests');
  assertInsideComposer(ui.lastFrame()!, 'skip the build');
  for (const line of (await readFile(new URL('../expected/pending-input.txt', import.meta.url), 'utf8')).trimEnd().split('\n')) assert.ok(ui.lastFrame()!.includes(line), ui.lastFrame());
  const pending = controller.queries.telemetry.pending('s1');
  await pressKey(ui, '/queue'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Pending input · Esc close') === true);
  await pressKey(ui, '\u001b[B'); await pressKey(ui, 'd');
  await until(() => controller.queries.foreground === undefined && controller.queries.telemetry.pending('s1').length === 1);
  assert.equal(controller.queries.telemetry.pending('s1')[0]!.id, pending[0]!.id);
  const request = object(object(object(fixture.calls.find(call => call.method === 'session/updateQueue')!.payload).args).request);
  assert.deepEqual(request, { sessionId: 's1', itemId: pending[1]!.id, action: { kind: 'remove' } });
  await pressKey(ui, '\u001b');
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
  fixture.control({ type: 'queue', sessionId: 's1', items: [] });
  await until(() => !ui.lastFrame()?.includes('Waiting:'));
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 3);
});

test('approval numbers and arrows require explicit selection and preserve command drafts', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  const results = () => fixture.calls.filter(call => call.method === '$events/result');
  // A draft written before the request arrived is parked, so the dialog answers without the user
  // having to clear it, and the draft is handed back once the request is settled.
  await until(() => controller.state.online && controller.queries.foreground === undefined);
  await pressKey(ui, 'half-written message');
  await until(() => ui.lastFrame()?.includes('half-written message') === true);
  for (const [index, keys] of [['1'], ['\u001b[B', '\u001b[B']].entries()) {
    fixture.emit({ type: 'waterfall', event: 'approval/request', eventId: `numbered-${index}`, agentId: 's1', request: { toolName: 'bash', reason: 'Confirm operation' } });
    await until(() => ui.lastFrame()?.includes('Approval required') === true);
    const expected = await readFile(new URL('../expected/approval-options.txt', import.meta.url), 'utf8');
    for (const line of expected.trimEnd().split('\n')) assert.ok(ui.lastFrame()!.includes(line), ui.lastFrame());
    assert.equal(ui.lastFrame()!.includes('half-written message'), false, ui.lastFrame());
    await pressKey(ui, '\r');
    assert.equal(results().length, index);
    for (const key of keys) await pressKey(ui, key);
    assert.equal(results().length, index);
    await pressKey(ui, '\r');
    await until(() => controller.state.pending.length === 0 && controller.queries.foreground === undefined);
    // Settling the last request hands the parked draft back.
    await until(() => ui.lastFrame()?.includes('half-written message') === true);
    const result = object(object(results().at(-1)!.payload).args);
    assert.equal(object(result.outcome).value, index === 0 ? 'allowed-once' : 'rejected');
  }
  fixture.emit({ type: 'waterfall', event: 'approval/request', eventId: 'stop-numbered', agentId: 's1', request: { description: 'Confirm stop' } });
  await until(() => ui.lastFrame()?.includes('Confirm stop') === true);
  await pressKey(ui, '3');
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
  await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'session/cancel'));
  assert.equal(results().length, 2);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('approval selection starts unselected, clears on Escape and resets when the request returns', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  const results = () => fixture.calls.filter(call => call.method === '$events/result');
  const cancellations = () => fixture.calls.filter(call => call.method === 'session/cancel').length;
  const request = (eventId: string) => fixture.emit({ type: 'waterfall', event: 'approval/request', eventId, agentId: 's1', request: { toolName: 'bash' } });
  // An upward arrow from the unselected state enters at the first choice, never at Stop turn.
  request('arrow-up');
  await until(() => ui.lastFrame()?.includes('Approval required') === true);
  await pressKey(ui, '\u001b[A');
  assert.match(ui.lastFrame()!, /❯ 1\. Allow once/);
  await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0);
  const allowed = object(object(results().at(-1)!.payload).args);
  assert.equal(object(allowed.outcome).value, 'allowed-once');
  assert.equal(cancellations(), 0);
  // Escape clears the highlight, so a later Enter neither answers nor cancels.
  request('escape-clears');
  await until(() => ui.lastFrame()?.includes('Approval required') === true);
  await pressKey(ui, '3');
  assert.match(ui.lastFrame()!, /❯ 3\. Stop turn/);
  await pressKey(ui, '\u001b');
  assert.doesNotMatch(ui.lastFrame()!, /❯ [123]\./);
  await pressKey(ui, '\r');
  await until(() => controller.queries.foreground === undefined);
  assert.equal(results().length, 1);
  assert.equal(cancellations(), 0);
  // Answering clears the request; when the same identity returns it is unselected again.
  await pressKey(ui, '2'); await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0);
  const denied = object(object(results().at(-1)!.payload).args);
  assert.equal(object(denied.outcome).value, 'rejected');
  request('escape-clears');
  await until(() => ui.lastFrame()?.includes('Approval required') === true);
  assert.doesNotMatch(ui.lastFrame()!, /❯ [123]\./);
  await pressKey(ui, '\r');
  await until(() => controller.queries.foreground === undefined);
  assert.equal(results().length, 2);
  assert.equal(cancellations(), 0);
  await pressKey(ui, '2'); await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0);
});

test('questions and approvals take precedence over the pending-input picker', async t => {
  const fixture = await host(); t.after(() => fixture.close()); fixture.queuePrompts = true;
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.queries.running);
  await pressKey(ui, 'pending instruction'); await pressKey(ui, '\r');
  await until(() => controller.queries.foreground === undefined && controller.queries.telemetry.pending('s1').length === 1);
  await pressKey(ui, '/queue'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Pending input · Esc close') === true);
  fixture.emit({ type: 'waterfall', event: 'user-questions/request', eventId: 'question-with-queue', agentId: 's1', request: { questions: [
    { id: 'q', question: 'Choose an action', options: [{ label: 'Keep' }, { label: 'Change' }] },
  ] } });
  await until(() => ui.lastFrame()?.includes('Choose an action') === true);
  assert.equal(await controller.actions.prompt('stale composer submission'), false);
  assert.match(controller.state.lastFailure, /pending question or approval/);
  await pressKey(ui, '2'); await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0 && controller.queries.foreground === undefined);
  const answer = object(object(fixture.calls.filter(call => call.method === '$events/result').at(-1)!.payload).args);
  assert.deepEqual(object(answer.outcome).value, { answers: [{ id: 'q', selected: ['Change'] }] });
  fixture.emit({ type: 'waterfall', event: 'approval/request', eventId: 'approval-with-queue', agentId: 's1', request: { description: 'Confirm operation' } });
  await until(() => ui.lastFrame()?.includes('Approval required') === true);
  // The approval owns the keyboard, so it is answered from its own list rather than by a command.
  await pressKey(ui, '1'); await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0 && controller.queries.foreground === undefined);
  const approval = object(object(fixture.calls.filter(call => call.method === '$events/result').at(-1)!.payload).args);
  assert.equal(object(approval.outcome).value, 'allowed-once');
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
  assert.equal(fixture.calls.some(call => call.method === 'session/updateQueue'), false);
  assert.equal(controller.queries.telemetry.pending('s1').length, 1);
});

test('help pages keep later slash commands accessible in a short terminal', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  Object.defineProperty(ui.stdout, 'rows', { value: 20, configurable: true });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Help 1/') === true);
  const count = Math.ceil(COMMAND_HINTS.length / 8);
  for (let page = 1; page < count; page++) await pressKey(ui, '\u001b[6~');
  assert.match(ui.lastFrame()!, /\/quit/);
  assert.match(ui.lastFrame()!, new RegExp(`Help ${count}/${count}`));
  await pressKey(ui, '\u001b[5~');
  assert.match(ui.lastFrame()!, new RegExp(`Help ${count - 1}/${count}`));
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('/export saves the session ZIP to the requested local path', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const root = await mkdtemp(join(tmpdir(), 'dsht-export-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 42]); fixture.exportBody = bytes;
  const path = join(root, 'session log.zip');
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, `/export "${path}"`); await pressKey(ui, '\r');
  await until(() => controller.queries.foreground === undefined && ui.lastFrame()?.includes('Saved session log:') === true);
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('/export-html saves the loaded conversation locally without submitting a prompt', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const root = await mkdtemp(join(tmpdir(), 'dsht-export-html-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'conversation view.html');
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.queries.record.ready);
  await pressKey(ui, `/export-html "${path}"`); await pressKey(ui, '\r');
  await until(() => controller.queries.foreground === undefined && ui.lastFrame()?.includes('Saved loaded conversation:') === true);
  assert.match(await readFile(path, 'utf8'), /你好/);
  assert.equal(fixture.exportRequests, 0);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('questions, approvals and model dialogs retain recent context above the composer', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 12, hasMore: false, header: { id: 's1' }, assistantStream: { revision: 0 }, records: [
    ...Array.from({ length: 12 }, (_, seq) => ({ type: 'event', event: { type: 'user/message', seq, surfaceOp: 'append', data: { content: [{ type: 'text', text: `Earlier context ${seq}` }] } } })),
    { type: 'event', event: { type: 'assistant/message', seq: 12, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'Recent decision context' }] } } } },
  ] };
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  Object.defineProperty(ui.stdout, 'columns', { value: 40, configurable: true });
  Object.defineProperty(ui.stdout, 'rows', { value: 24, configurable: true });
  controller.start(); await until(() => ui.lastFrame()?.includes('Recent decision context') === true);
  fixture.emit({ type: 'waterfall', event: 'user-questions/request', eventId: 'context-question', agentId: 's1', request: { questions: [
    { id: 'q', question: 'Continue with this approach?', options: [{ label: 'Continue' }, { label: 'Revise' }] },
  ] } });
  await until(() => ui.lastFrame()?.includes('Continue with this approach?') === true);
  const questionFrame = ui.lastFrame()!;
  assert.ok(questionFrame.indexOf('Recent decision context') >= 0, questionFrame);
  assert.ok(questionFrame.indexOf('Recent decision context') < questionFrame.indexOf('╭'), questionFrame);
  assert.match(questionFrame, /❯ 1\. Continue/);
  assert.match(questionFrame, /2\. Revise/);
  await pressKey(ui, '\u001b[<64;10;5M');
  assert.doesNotMatch(ui.lastFrame()!, /Recent decision context/);
  assert.match(ui.lastFrame()!, /❯ 1\. Continue/);
  await pressKey(ui, '\u001b[<65;10;5M');
  assert.match(ui.lastFrame()!, /Recent decision context/);
  await pressKey(ui, '\u001b[<0;10;5M');
  assert.doesNotMatch(ui.lastFrame()!, /Copy mode/);
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
  await pressKey(ui, '\u001b[5~');
  assert.doesNotMatch(ui.lastFrame()!, /Recent decision context/);
  assert.match(ui.lastFrame()!, /Earlier context/);
  assert.match(ui.lastFrame()!, /❯ 1\. Continue/);
  await pressKey(ui, '\u001b[6~');
  assert.match(ui.lastFrame()!, /Recent decision context/);
  await pressKey(ui, '2'); await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0 && controller.queries.foreground === undefined);
  fixture.emit({ type: 'waterfall', event: 'approval/request', eventId: 'context-approval', agentId: 's1', request: { description: 'Confirm operation' } });
  await until(() => ui.lastFrame()?.includes('Approval required') === true);
  assert.match(ui.lastFrame()!, /Recent decision context/);
  await pressKey(ui, '2'); await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0 && controller.queries.foreground === undefined);
  await pressKey(ui, '/model'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Choose model') === true);
  assert.match(ui.lastFrame()!, /Recent decision context/);
});

test('the status bar reports a verifying loop instead of claiming Ready', async t => {
  const fixture = await host();
  // A verifier that never answers holds the run in its verify-first step, which is the state that used
  // to leave the bar saying Ready while the client was plainly working.
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const verifier: VerifierPort = { name: 'fake', verify: async () => { await gate; return { type: 'cancelled' }; } };
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier });
  const ui = render(<App controller={controller} />);
  t.after(async () => { release?.(); ui.unmount(); ui.cleanup(); await controller.stop(); fixture.close(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '/loop');
  await until(() => ui.lastFrame()?.includes('Loop records') === true);
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Run loop record · designdoc-review') === true);
  await pressKey(ui, '\r');
  // The sub-state comes from the controller, so the assertion follows the field rather than the frame.
  await until(() => controller.queries.loop?.activity === 'verify');
  // The selected session has no host turn, so the bar must take its state from the loop itself.
  assert.match(ui.lastFrame()!, /◐/);
  assert.match(ui.lastFrame()!, /verify 1\/10/);
  assert.doesNotMatch(ui.lastFrame()!, /● Ready/);
});

test('/loop runs the highlighted record with its defaults after two Enters', async t => {
  const fixture = await host();
  const directory = await mkdtemp(join(tmpdir(), 'dsht-loop-ui-trace-'));
  const tracePath = join(directory, 'trace.log');
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', tracePath });
  const ui = render(<App controller={controller} />);
  // One hook in the right order: the controller drains its trace before the directory goes away.
  t.after(async () => {
    ui.unmount(); ui.cleanup();
    await controller.stop();
    fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  controller.start();
  await until(() => controller.queries.record.ready);
  // The shortest path a reader takes: `/loop`, Enter on the list, Enter on Start.
  await pressKey(ui, '/loop');
  await until(() => ui.lastFrame()?.includes('Loop records') === true);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Run loop record · design-review') === true);
  await pressKey(ui, '\r');
  await until(() => controller.queries.loop !== undefined);
  assert.equal(controller.queries.loop?.title, 'Design review');
  assert.deepEqual({ from: controller.queries.loop?.from, to: controller.queries.loop?.to, score: controller.queries.loop?.score, tries: controller.queries.loop?.tries },
    { from: 1, to: 10, score: 8, tries: 10 });
  // The trace tells the whole story of this start, so a run that never happens has a written reason.
  await controller.trace?.settle();
  const events = (await readTrace(tracePath)).filter(line => !line.startsWith('#'))
    .map(line => JSON.parse(line) as { event: string; phase?: string });
  assert.deepEqual(events.filter(entry => entry.event === 'loop-ui').map(entry => entry.phase), ['choose', 'open', 'start']);
  // `sent` follows the prompt's round trip, so it is waited for rather than assumed.
  let loopEvents: (string | undefined)[] = [];
  for (let attempt = 0; attempt < 50 && !loopEvents.includes('sent'); attempt += 1) {
    await controller.trace?.settle();
    loopEvents = (await readTrace(tracePath)).filter(line => !line.startsWith('#'))
      .map(line => JSON.parse(line) as { event: string; phase?: string })
      .filter(entry => entry.event === 'loop').map(entry => entry.phase);
    if (!loopEvents.includes('sent')) await new Promise(resolve => setTimeout(resolve, 20));
  }
  // Two executed lines, both traced: the menu's pick asks the application for the form, and Start
  // then runs it. Nothing about the choice is decided in the UI.
  assert.deepEqual(loopEvents, ['command', 'form', 'command', 'begin', 'sent']);
});

test('lines the policy holds run in arrival order once the turn ends', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.queries.running);
  // Two commands that write to the conversation are accepted and held, not refused.
  await pressKey(ui, '/compact'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Queued /compact') === true);
  await pressKey(ui, '/handoff'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Queued /handoff') === true);
  assert.equal(fixture.calls.some(call => call.method === 'commands/execute'), false);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
  // The turn ends: the held lines run in the order they were submitted.
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const methods = fixture.calls.map(call => call.method);
  assert.ok(methods.indexOf('commands/execute') >= 0 && methods.indexOf('commands/execute') < methods.indexOf('session/prompt'),
    methods.join(','));
});

test('/loop form Start is held while a turn runs, then starts with the confirmed values', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  // Open the form while the client is idle: the record is known and nothing is running.
  await pressKey(ui, '/loop design-review'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Run loop record · design-review') === true);
  // A turn starts in the background while the form is being filled in. Start is a second submission,
  // so it is authorized again — which now means "held", not "started into a busy conversation".
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.queries.running);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Queued /loop design-review') === true);
  assert.equal(controller.queries.loop, undefined);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
  // The turn ends, and the held line runs with the values the form confirmed.
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const started = (): { active?: boolean; title?: string } | undefined => controller.queries.loop;
  assert.equal(started()?.active, true);
  assert.equal(started()?.title, 'Design review');
});

test('/loop stop ends the run from the composer instead of offering it as a record', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  // `stop` is `/loop`'s own subcommand, so it never filters the record list and runs on Enter.
  await pressKey(ui, '/loop stop');
  assert.doesNotMatch(ui.lastFrame()!, /Loop records/);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('No loop is running') === true);
  // Start one, then end it the same way: the terminal line stays, the run is no longer active.
  await pressKey(ui, '/loop design-review 9'); await pressKey(ui, '\r');
  // The start itself holds the controller's busy envelope; the run then owns the session while the
  // composer is free again, which is the state the operator stops it from (D1 brings editing during
  // the envelope itself).
  await until(() => controller.queries.loop?.active === true && controller.queries.foreground === undefined);
  await pressKey(ui, '/loop stop'); await pressKey(ui, '\r');
  await until(() => controller.queries.loop?.active === false);
  assert.equal(controller.queries.loop?.terminalReason, 'user-cancelled');
  await until(() => ui.lastFrame()?.includes('Loop stopped') === true);
});

test('a run that pauses for a person says so and resumes on /loop answer', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '/loop design-review 9'); await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  // The agent's reply abstains, which pauses the run rather than ending it.
  const block = '```dsht-loop\n' + JSON.stringify({ kind: 'design-review', step: 1, attempt: 1,
    status: 'abstained', exit_reason: 'needs-human', reason: '需要人决定改哪一侧', needs: '改哪一侧？' }) + '\n```';
  fixture.follow({ type: 'event', event: { seq: 9, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: `findings\n${block}` }] } } } });
  await until(() => controller.queries.record.messages.some(message => message.text.includes('dsht-loop')));
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => controller.queries.loop?.phase === 'needs-human');
  assert.equal(controller.queries.loop?.active, true);
  // Both the progress line and the status bar name what to do about it.
  await until(() => ui.lastFrame()?.includes('needs you · /loop answer') === true);
  // The bar asks for the reader instead of claiming Ready, and the progress line names the command.
  assert.match(ui.lastFrame()!, /⏸ needs you/);
  // The answer goes back to the agent as the next attempt's instruction, still without spending one.
  const before = fixture.calls.filter(call => call.method === 'session/prompt').length;
  await pressKey(ui, '/loop answer 以 tui-design.md 为准'); await pressKey(ui, '\r');
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length > before);
  const sent = fixture.calls.filter(call => call.method === 'session/prompt').at(-1)!;
  const text = String(object(array(object(object(object(sent.payload).args).request).content)[0]).text);
  assert.match(text, /操作者的补充判断/);
  assert.match(text, /以 tui-design\.md 为准/);
  assert.equal(controller.queries.loop?.attempt, 1);
});

test('/loop lists its records, opens the chosen inputs and runs exactly those values', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  // `/loop` alone stops being a syntax error and offers the records with their defaults.
  await pressKey(ui, '/loop');
  await until(() => ui.lastFrame()?.includes('Loop records') === true);
  assert.match(ui.lastFrame()!, /❯ design-review · Design review · 10 rounds · pass 8 · ≤10 tries · DESIGN-REVIEW\.md/);
  await pressKey(ui, '\u001b[B');
  await until(() => ui.lastFrame()?.includes('❯ designdoc-review') === true);
  // Enter confirms the highlighted record and opens its defaults instead of running blind.
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Run loop record · designdoc-review') === true);
  // The record's own input is the first editable row, so another document can be reviewed here.
  assert.match(ui.lastFrame()!, /path\s+tui-design\.md/);
  const beforeStart = controller.queries.loop;
  assert.equal(beforeStart, undefined);
  await pressKey(ui, '\u001b[B'); // path
  await pressKey(ui, 'docs/other.md');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('docs/other.md') === true);
  // Then over the passing score, so one form confirms both a variable and a limit.
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\u001b[B'); // Pass
  await pressKey(ui, '\x7f'); await pressKey(ui, '9');
  await pressKey(ui, '\r');
  await pressKey(ui, '\u001b[A'); await pressKey(ui, '\u001b[A'); await pressKey(ui, '\u001b[A');
  await pressKey(ui, '\u001b[A'); await pressKey(ui, '\u001b[A'); // back to Start
  await pressKey(ui, '\r');
  await until(() => controller.queries.loop !== undefined);
  assert.equal(controller.queries.loop?.title, 'Designdoc review · docs/other.md');
  assert.deepEqual({ from: controller.queries.loop?.from, to: controller.queries.loop?.to, score: controller.queries.loop?.score, tries: controller.queries.loop?.tries },
    { from: 1, to: 10, score: 9, tries: 10 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const sent = fixture.calls.filter(call => call.method === 'session/prompt').at(-1)!;
  const text = String(object(array(object(object(object(sent.payload).args).request).content)[0]).text);
  assert.match(text, /docs\/other\.md/);
  assert.doesNotMatch(text, /tui-design\.md/);
});

test('a command with arguments shows what it takes once the name is settled', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '/think ');
  await until(() => ui.lastFrame()?.includes('/think [seq or live]') === true);
  assert.match(ui.lastFrame()!, /\/think \[seq or live\] · Inspect reasoning with user prompt summaries/);
  // `/loop` has a more specific list, so the generic usage line gives way to it instead of stacking.
  await pressKey(ui, '\u0015');
  await pressKey(ui, '/loop ');
  await until(() => ui.lastFrame()?.includes('Loop records') === true);
  assert.doesNotMatch(ui.lastFrame()!, /List loop\.yaml records/);
});

test('Ctrl+O opens the read-only view on a local run and Esc gives the composer back', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  controller.shell.start('seq 1 30');
  await until(() => controller.shell.runs[0]?.status === 'exited');

  await pressKey(ui, '\u000f');
  await until(() => ui.lastFrame()?.includes('! seq 1 30') === true);
  const frame = ui.lastFrame()!;
  // The panel is the source, not the conversation: its identity, its newest lines, and its own footer.
  assert.match(frame, /^.*! seq 1 30/m);
  assert.match(frame, /shell:1 · local process · ended · from s1 · ran \d+s/);
  assert.match(frame, /lines \d+–30 of 30/);
  assert.match(frame, /Esc closes/);
  // The composer is gone while the view owns the screen.
  assert.doesNotMatch(frame, /Message, @host-file, or \/help/);

  // Arrows scroll the view without touching the conversation behind it.
  for (let step = 0; step < 25; step++) await pressKey(ui, '\u001b[A');
  await until(() => /lines 1–\d+ of 30/.test(ui.lastFrame() ?? ''));
  for (let step = 0; step < 25; step++) await pressKey(ui, '\u001b[B');
  await until(() => /lines \d+–30 of 30/.test(ui.lastFrame() ?? ''));

  await pressKey(ui, '\u001b');
  await until(() => ui.lastFrame()?.includes('Message, @host-file, or /help') === true);
  assert.doesNotMatch(ui.lastFrame()!, /Esc closes/);
  // The conversation is back where it was: the block's output is still in the transcript.
  assert.match(ui.lastFrame()!, /30/);
});

test('Ctrl+O follows a subagent child and shows what that session streams', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.subagent = { sessionId: 'child-1', origin: 'subagent', parentSessionId: 's1',
    projections: { values: { title: 'explore the parser' } } };
  // The child belongs to the selected workspace, which is the list a reader sees.
  fixture.baseline = [{ workspaceId: 'w1', title: 'Project α', path: '/host/project', sessionIds: ['s1', 'child-1'] }];
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);

  await pressKey(ui, '\u000f');
  await until(() => ui.lastFrame()?.includes('explore the parser') === true);
  assert.match(ui.lastFrame()!, /child-1 · session · ended · from s1/);
  await until(() => ui.lastFrame()?.includes('你好') === true);
  fixture.follow({ type: 'event', event: { seq: 9, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: 'the parser lives in parse.ts' }] } } } });
  await until(() => ui.lastFrame()?.includes('the parser lives in parse.ts') === true);

  // Esc releases the follow: the child's stream stops with the view.
  const cancelled = fixture.cancels.length;
  await pressKey(ui, '\u001b');
  await until(() => fixture.cancels.length > cancelled);
  assert.doesNotMatch(ui.lastFrame()!, /explore the parser/);
});

test('clicking a local command bar opens that run read-only, other rows still copy', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  controller.shell.start('echo click-target');
  await until(() => controller.shell.runs[0]?.status === 'exited');

  // The bar the click is aimed at is the row the reader sees, so the test finds it in the frame
  // instead of assuming a screen offset: the application's own row math must agree with Ink's.
  const barRow = ui.lastFrame()!.split('\n').findIndex(line => line.includes('! echo click-target'));
  assert.ok(barRow >= 0, ui.lastFrame()!);
  await pressKey(ui, `\u001b[<0;5;${barRow + 1}M`);
  await until(() => ui.lastFrame()?.includes('Esc closes') === true);
  assert.match(ui.lastFrame()!, /! echo click-target/);
  assert.match(ui.lastFrame()!, /shell:1 · local process · ended/);
  await pressKey(ui, '\u001b');

  // A press on an ordinary conversation row is not a click target: it still enters copy mode.
  await until(() => ui.lastFrame()?.includes('Message, @host-file, or /help') === true);
  const messageRow = ui.lastFrame()!.split('\n').findIndex(line => line.includes('你好'));
  assert.ok(messageRow >= 0, ui.lastFrame()!);
  await pressKey(ui, `\u001b[<0;5;${messageRow + 1}M`);
  await until(() => ui.lastFrame()?.includes('Copy mode') === true);
  assert.doesNotMatch(ui.lastFrame()!, /Esc closes/);
});

test('the bar /loop leaves in the transcript opens the verification session', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  // The verifier creates its own session — the way the forked process does — and then never answers,
  // so the run stays in the verification it just started.
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let created: string | undefined;
  const verifier: VerifierPort = { name: 'fake', verify: async request => {
    created = await controller.actions.createVerifierSession(request.title);
    await gate;
    return { type: 'cancelled' };
  } };
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier });
  const ui = render(<App controller={controller} />);
  t.after(async () => { release?.(); ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  await pressKey(ui, '/loop');
  await until(() => ui.lastFrame()?.includes('Loop records') === true);
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Run loop record · designdoc-review') === true);
  await pressKey(ui, '\r');
  await until(() => controller.queries.loop?.activity === 'verify');

  // The run echoed one bar where it started, and it points at the session doing the check.
  await until(() => ui.lastFrame()?.includes('click this bar to read it') === true);
  assert.equal(created, 's-new');
  const frame = ui.lastFrame()!;
  assert.match(frame, /\/loop designdoc-review 1–10 · pass 8 · ≤10 tries/);
  assert.match(frame, /s-new · click this bar to read it/);
  // The bar itself is the row the reader clicks; SGR rows are one-based.
  const barRow = frame.split('\n').findIndex(line => line.includes('/loop designdoc-review'));
  assert.ok(barRow >= 0, frame);
  await pressKey(ui, `\u001b[<0;5;${barRow + 1}M`);
  await until(() => ui.lastFrame()?.includes('Esc closes') === true);
  const panel = ui.lastFrame()!;
  // The panel is the verifier's session, not the reviewed conversation.
  assert.match(panel, /Designdoc review · tui-design\.md · 1\/1/);
  assert.match(panel, /s-new · verifier fake · running · from s1/);
  // The client header still names the conversation the view was opened from.
  assert.match(panel, /First conversation/);
  await pressKey(ui, '\u001b');
  await until(() => ui.lastFrame()?.includes('First conversation') === true);
});
