/** Drive the actual terminal components against the isolated HTTP host. */
import './no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React, { act, useEffect } from 'react';
import { render } from 'ink-testing-library';
import { App, commonPrefix } from '../src/app.tsx';
import { Controller } from '../src/controller.ts';
import { array, object } from '../src/wire.ts';
import { host, until } from './host.ts';
import { StatusBar } from '../src/status.tsx';

test('startup requires workspace and session selection before showing the composer', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token');
  const ui = render(<App controller={controller} />);
  const press = (value: string) => pressKey(ui, value);
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
  await press('explain @');
  await until(() => ui.lastFrame()?.includes('❯ src/') === true);
  const expected = await readFile(new URL('./expected/file-references.txt', import.meta.url), 'utf8');
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
  await until(() => !controller.state.busy);
  await press('@missing');
  await until(() => ui.lastFrame()?.includes('No matching host files') === true);
  const cancelCount = fixture.calls.filter(call => call.method === 'session/cancel').length;
  await press('\u001b');
  await until(() => !ui.lastFrame()?.includes('Host files'));
  assert.equal(fixture.calls.filter(call => call.method === 'session/cancel').length, cancelCount);
  await press('\r');
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === before + 2);
  await until(() => !controller.state.busy);
  await press('/ws Project α');
  await until(() => ui.lastFrame()?.includes('/ws Project α') === true);
  await press('\r');
  await until(() => controller.state.screen === 'sessions' && !controller.state.busy);
  await until(() => !ui.lastFrame()?.includes('/ws Project α'));
  await press('/s s1');
  await until(() => ui.lastFrame()?.includes('/s s1') === true);
  await press('\r');
  await until(() => controller.state.screen === 'chat' && controller.state.sessionId === 's1')
    .catch(error => { throw new Error(`${error}\n${ui.lastFrame()}\n${controller.state.error}`); });
  await until(() => !controller.state.busy);
  await press('/s all');
  await until(() => ui.lastFrame()?.includes('/s all') === true);
  await press('\r');
  await until(() => ui.lastFrame()?.includes('Choose session · All workspaces') === true);
  assert.equal(controller.visibleSessions.length, 2);
  await until(() => !controller.state.busy);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const original = controller.references.bind(controller);
  let oldSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  controller.references = async (query, signal) => {
    if (query !== 'old') return original(query, signal);
    oldSignal = signal;
    await delayed;
    return [{ path: 'obsolete-result.ts', kind: 'file' }];
  };
  const ui = render(<App controller={controller} />);
  t.after(async () => { release!(); ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  let exited = false;
  function MountedApp() {
    useEffect(() => () => { exited = true; }, []);
    return <App controller={controller} />;
  }
  const ui = render(<MountedApp />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.running);
  await pressKey(ui, '@');
  await until(() => ui.lastFrame()?.includes('Host files') === true);
  // The open completion belongs to the draft: the first Ctrl+C discards it without stopping the turn.
  await pressKey(ui, '\u0003');
  await until(() => ui.lastFrame()?.includes('Host files') === false);
  assert.equal(exited, false);
  assert.equal(controller.running, true);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
  await pressKey(ui, '\u0003');
  await until(() => fixture.calls.some(call => call.method === 'session/cancel'));
  assert.equal(exited, false);
  await until(() => controller.state.status.includes('Cancellation requested'));
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => !controller.running);
  await pressKey(ui, '\u0003');
  await until(() => exited);
});

test('status bar follows host metrics, elapsed working time, cancellation and generation replacement', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.controlBaseline = { projections: { s1: { asOfSeq: 5, values: {
    modelSelection: { lastUsed: { provider: 'p', model: 'chat' }, next: { provider: 'p', model: 'chat' } },
    contextPressure: { projectedTokens: 25, contextWindow: 100 },
    tokenUsage: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 },
  } } }, queues: { s1: [1, 2] }, jobs: { s1: [{ status: 'running' }] } };
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready && ui.lastFrame()?.includes('tok: 1K') === true);
  const compact = ui.lastFrame()!.split('\n').find(line => line.includes('ctx:'))!;
  assert.match(compact, /ws: Project α.*ctx: ~25%.*tok: 1K/);
  assert.equal(ui.lastFrame()?.includes('Workspace:'), false);
  await pressKey(ui, '/status');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Tokens: 1,000 total') === true);
  for (const line of (await readFile(new URL('./expected/status-bar.txt', import.meta.url), 'utf8')).trimEnd().split('\n')) {
    assert.ok(ui.lastFrame()!.includes(line), ui.lastFrame());
  }
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => ui.lastFrame()?.includes('Working 0m 1s') === true);
  fixture.control({ type: 'projection', sessionId: 's1', key: 'contextPressure', seq: 6, value: { projectedTokens: 50, contextWindow: 100 } });
  fixture.control({ type: 'queue', sessionId: 's1', items: [] });
  await until(() => ui.lastFrame()?.includes('Context: ~50%') === true && ui.lastFrame()?.includes('Queued: 0') === true);
  await pressKey(ui, '\u001b');
  await until(() => fixture.calls.some(call => call.method === 'session/cancel'));
  // Esc closed the details panel; reopen it to watch the metrics across a reconnect.
  assert.equal(ui.lastFrame()?.includes('Tokens: 1,000 total'), false);
  await pressKey(ui, '/status');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Tokens: 1,000 total') === true);
  fixture.controlBaseline = { projections: {}, queues: {}, jobs: {} };
  fixture.disconnect();
  await until(() => !controller.state.online);
  await until(() => controller.state.transcript.ready && controller.state.online);
  await until(() => ui.lastFrame()?.includes('Context: unknown') === true);
  assert.equal(ui.lastFrame()?.includes('Tokens: 1,000 total'), false);
  await pressKey(ui, '/status');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('ctx: ?') === true);
  assert.equal(ui.lastFrame()?.includes('Workspace:'), false);
});

test('hosts without a control stream show unknown metrics and refresh catalog defaults on settings changes', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.controlAvailable = false;
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
  await pressKey(ui, '/status');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Model: fixture/chat') === true);
  assert.match(ui.lastFrame()!, /Live metrics unavailable/);
  assert.match(ui.lastFrame()!, /Tokens: \? total/);
  fixture.defaultModel = { provider: 'fixture', model: 'new-default' };
  fixture.emit({ type: 'emit', event: 'settings/document-updated', args: [] });
  await until(() => ui.lastFrame()?.includes('Model: fixture/new-default') === true);
  assert.equal(controller.state.online, true);
});

test('terminal control keys edit the submitted prompt and keep reference completion at the draft end', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
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
  const expected = await readFile(new URL('./expected/input-edit.txt', import.meta.url), 'utf8');
  assert.ok(ui.lastFrame()!.includes(expected.trimEnd()), ui.lastFrame());
  await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const sent = fixture.calls.find(call => call.method === 'session/prompt')!;
  assert.deepEqual(object(object(object(sent.payload).args).request).content, [{ type: 'text', text: 'Alpha beta done' }]);
  await until(() => !controller.state.busy);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('你好') === true);
  const transcript = controller.state.transcript;
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('history-record-39') === true);
  const press = (value: string) => pressKey(ui, value);
  await press('\x1b[<64;3;4M');
  await until(() => !ui.lastFrame()?.includes('history-record-39'));
  for (let i = 0; i < 20; i++) await press('\x1b[<64;3;4M');
  await until(() => !controller.state.transcript.hasMore && !controller.state.busy);
  assert.equal(fixture.calls.filter(call => call.method === 'session/page').length, 1);
  const page = fixture.calls.find(call => call.method === 'session/page')!;
  assert.equal(object(object(object(page.payload).args).request).beforeSeq, 20);
  await press('\x1b[<0;3;4M');
  await press('/search history-record-5'); await press('\r');
  await until(() => ui.lastFrame()?.includes('#5 You · history-record-5') === true);
  await until(() => !controller.state.busy);
  await press('\r');
  await until(() => !ui.lastFrame()?.includes('History · your prompts') && ui.lastFrame()?.includes('history-record-5') === true);
  for (let i = 0; i < 60; i++) await press('\x1b[<65;3;4M');
  await until(() => ui.lastFrame()?.includes('history-record-39') === true && !controller.state.busy);
  for (let i = 0; i < 60; i++) await press('\x1b[<64;3;4M');
  await until(() => ui.lastFrame()?.includes('history-record-0') === true && !controller.state.busy);
  await press('/wsearch 你好'); await press('\r');
  await until(() => ui.lastFrame()?.includes('s2 · 你好 too') === true && !controller.state.busy);
  await press('\x1b');
  await press('/ssearch 你好'); await press('\r');
  await until(() => ui.lastFrame()?.includes('s1 · 你好') === true && !controller.state.busy);
  assert.equal(ui.lastFrame()?.includes('s2 · 你好 too'), false);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('search loads old messages, opens cross-session matches and cancels local paging', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 10, hasMore: true, header: { id: 's1' }, records: [
    { type: 'event', event: { seq: 10, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'recent' }] } } },
  ] };
  fixture.onPage = async () => ({ records: [
    { type: 'event', event: { seq: 0, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'needle in old history' }] } } },
  ], hasMore: false });
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  let release: (() => void) | undefined;
  t.after(async () => { release?.(); ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
  const press = (value: string) => pressKey(ui, value);
  await press('/search needle'); await press('\r');
  await until(() => ui.lastFrame()?.includes('#0 You · needle in old history') === true && !controller.state.busy);
  const expected = await readFile(new URL('./expected/history-navigation.txt', import.meta.url), 'utf8');
  for (const line of expected.trimEnd().split('\n')) assert.ok(ui.lastFrame()!.includes(line), ui.lastFrame());
  await press('\r');
  await until(() => !ui.lastFrame()?.includes('Search · session history') && !controller.state.busy);
  fixture.searchResult = { items: [{ sessionId: 's2', snippet: 'needle' }], hasMore: false };
  await press('/wsearch needle'); await press('\r');
  await until(() => ui.lastFrame()?.includes('s2 · needle') === true && !controller.state.busy);
  await press('\r');
  await until(() => controller.state.sessionId === 's2' && ui.lastFrame()?.includes('#0 You · needle in old history') === true && !controller.state.busy);
  await press('\x1b');
  await controller.selectSession('s1');
  await until(() => controller.state.transcript.ready);
  const cancelCount = fixture.calls.filter(call => call.method === 'session/cancel').length;
  let requested = false;
  fixture.onPage = async () => { requested = true; await new Promise<void>(resolve => { release = resolve; }); return { records: [], hasMore: false }; };
  await press('/search absent'); await press('\r');
  await until(() => requested);
  await press('\x1b');
  await until(() => !controller.state.busy);
  assert.equal(fixture.calls.filter(call => call.method === 'session/cancel').length, cancelCount);
  assert.equal(controller.state.transcript.hasMore, true);
  release!();
});

test('/cost displays cached session, daily and three-day estimates without submitting a prompt', async t => {
  const { CostLedger, costRecords } = await import('../src/cost.ts');
  const fixture = await host(); t.after(() => fixture.close());
  const ledger = new CostLedger();
  const recording = (await readFile(new URL('./fixtures/workspace-edit.session.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => object(JSON.parse(line)));
  await ledger.replace('s1', recording.length - 2, costRecords(recording.slice(1).map((event, seq) => ({ type: 'event', event: { ...event, seq } }))));
  // Retain the recorded usage while this test exercises the terminal command.
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, ledger);
  controller.refreshCosts = async () => {};
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  await pressKey(ui, '/cost'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Cost · CNY estimate') === true);
  const expected = await readFile(new URL('./expected/cost.txt', import.meta.url), 'utf8');
  for (const line of expected.trimEnd().split('\n')) assert.ok(ui.lastFrame()?.includes(line), ui.lastFrame());
  assert.equal(fixture.calls.some(c => c.method === 'session/prompt'), false);
});

test('header follows session titles and Esc cancels despite a stale idle flag, retaining the acknowledgement', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  let release: (() => void) | undefined;
  fixture.onCancel = () => new Promise<void>(resolve => { release = resolve; });
  const ui = render(<App controller={controller} />);
  t.after(async () => { release?.(); ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('Project α / First conversation') === true);
  fixture.control({ type: 'projection', sessionId: 's1', key: 'title', seq: 1, value: { title: 'Readable session title' } });
  await until(() => ui.lastFrame()?.includes('Project α / Readable session title') === true);
  assert.equal(controller.running, false);
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
  await until(() => ui.lastFrame()?.includes('Session ID: s1') === true);
  fixture.onCancel = undefined;
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.running);
  await pressKey(ui, '@');
  await until(() => ui.lastFrame()?.includes('Host files') === true);
  await pressKey(ui, '\x1b');
  await until(() => fixture.calls.filter(call => call.method === 'session/cancel').length === 2);
  assert.equal(ui.lastFrame()?.includes('Host files'), false);
});

test('quitting cancels the selected running turn before the client closes', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  let exited = false;
  function MountedApp() {
    useEffect(() => () => { exited = true; }, []);
    return <App controller={controller} />;
  }
  const ui = render(<MountedApp />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.running);
  await pressKey(ui, '/quit'); await pressKey(ui, '\r');
  await until(() => exited);
  // Unmounting alone leaves host work running; the lifetime around the render cancels it.
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
  await controller.shutdown();
  assert.equal(fixture.calls.filter(call => call.method === 'session/cancel').length, 1);
});

test('closing an idle client sends no cancellation', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  controller.start();
  await until(() => controller.state.transcript.ready);
  await controller.shutdown();
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});

test('a slash-command panel closes on the next command or after its lifetime', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} panelLifetimeMs={150} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('/ws [name or ID]') === true);
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Session ID: s1') === true);
  // The next command replaced the previous panel.
  assert.equal(ui.lastFrame()!.includes('/ws [name or ID]'), false);
  // Without another command the panel closes on its own.
  await until(() => ui.lastFrame()?.includes('Session ID: s1') === false);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('Esc closes an open command panel and keeps the draft beside it', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('/ws [name or ID]') === true);
  await pressKey(ui, 'plain draft');
  await until(() => ui.lastFrame()?.includes('plain draft') === true);
  await pressKey(ui, '\u001b');
  await until(() => ui.lastFrame()?.includes('/ws [name or ID]') === false);
  assert.equal(ui.lastFrame()?.includes('plain draft'), true);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});

test('cost coverage warns through the status prefix instead of rewriting a subtotal', async t => {
  const { CostLedger, costRecords } = await import('../src/cost.ts');
  const fixture = await host(); t.after(() => fixture.close());
  const ledger = new CostLedger();
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, ledger);
  controller.state = { ...controller.state, sessionId: 's1', online: true };
  const bar = (expanded = false) => {
    const ui = render(<StatusBar controller={controller} expanded={expanded} />);
    const frame = ui.lastFrame() ?? '';
    ui.unmount(); ui.cleanup();
    return frame;
  };
  // With nothing cached the prefix warns, and no subtotal claims incompleteness of its own.
  assert.match(bar(), /! Idle/);
  assert.match(bar(), /S:\? D:~¥0\.0000(?!\*)/);
  await ledger.replace('s1', 1, costRecords([{ type: 'event', event: { seq: 0, time: Date.parse('2026-09-10T10:00:00+08:00'),
    type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } } }]));
  // Charges cached by an earlier run already cover the history, so the bar stops warning.
  const cached = bar();
  assert.doesNotMatch(cached, /! Idle/);
  assert.match(cached, /S:~¥2\.0000/);
  assert.match(bar(true), /Cost \(CNY estimate\): Session ~¥2\.0000/);
  ledger.error = 'scan failed';
  assert.match(bar(), /! Idle/);
  assert.match(bar(true), /Cost coverage incomplete: scan failed/);
});

test('Tab completes a slash command and stops at an ambiguous shared prefix', async t => {
  assert.equal(commonPrefix(['/ws', '/wsearch']), '/ws');
  assert.equal(commonPrefix(['/help']), '/help');
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
  await pressKey(ui, '/w'); await pressKey(ui, '\t');
  await until(() => ui.lastFrame()?.includes('❯ /ws') === true);
  await pressKey(ui, '\u0015');
  await pressKey(ui, '/he'); await pressKey(ui, '\t');
  await until(() => ui.lastFrame()?.includes('❯ /help') === true);
});
