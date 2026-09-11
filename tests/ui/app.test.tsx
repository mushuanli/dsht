/** Drive the actual terminal components against the isolated HTTP host. */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React, { act, useEffect } from 'react';
import { render } from 'ink-testing-library';
import { App, COMMAND_HINTS, commonPrefix } from '../../src/ui/app.tsx';
import { Controller } from '../../src/controller/controller.ts';
import { array, object, type ObjectValue } from '../../src/transport/wire.ts';
import { host, snapshot, until } from '../support/host.ts';
import { StatusBar } from '../../src/ui/chat/status.tsx';

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

test('startup requires workspace and session selection before showing the composer', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token');
  const ui = render(<App controller={controller} />);
  const press = (value: string) => pressKey(ui, value);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => ui.lastFrame()?.includes('Project α') === true);
  assert.match(ui.lastFrame()!, /Choose workspace/);
  assertInsideComposer(ui.lastFrame()!, 'Choose workspace');
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
  await press('/resume s1');
  await until(() => ui.lastFrame()?.includes('/resume s1') === true);
  await press('\r');
  await until(() => controller.state.screen === 'chat' && controller.state.sessionId === 's1')
    .catch(error => { throw new Error(`${error}\n${ui.lastFrame()}\n${controller.state.error}`); });
  await until(() => !controller.state.busy);
  await press('/resume all');
  await until(() => ui.lastFrame()?.includes('/resume all') === true);
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
    sessionStats: { turns: 42 },
    contextPressure: { projectedTokens: 25, contextWindow: 100 },
    tokenUsage: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 },
  } } }, queues: { s1: [1, 2].map(id => ({ id: String(id), placement: 'steering', message: { id: String(id), content: [{ type: 'text', text: `Pending ${id}` }] } })) }, jobs: { s1: [{ status: 'running' }] } };
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready && ui.lastFrame()?.includes('1K tok') === true);
  const compact = ui.lastFrame()!.split('\n').find(line => line.includes('1K tok'))!;
  assert.match(compact, /● Ready.*chat.*~25%.*1K tok/);
  assert.equal(ui.lastFrame()?.includes('Workspace:'), false);
  assert.match(ui.lastFrame()!, /First conversation/);
  await pressKey(ui, '/status');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Tokens: 1,000 total') === true);
  for (const line of (await readFile(new URL('../expected/status-bar.txt', import.meta.url), 'utf8')).trimEnd().split('\n')) {
    assert.ok(ui.lastFrame()!.includes(line), ui.lastFrame());
  }
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Working · 1s') === true);
  fixture.control({ type: 'projection', sessionId: 's1', key: 'contextPressure', seq: 6, value: { projectedTokens: 50, contextWindow: 100 } });
  fixture.control({ type: 'queue', sessionId: 's1', items: [] });
  await until(() => controller.telemetry.view('s1').queued === 0);
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
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
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Context: unknown') === true);
  assert.equal(ui.lastFrame()?.includes('Tokens: 1,000 total'), false);
  await pressKey(ui, '/status');
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('ctx ?') === true);
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
  await until(() => controller.state.defaultModel?.model === 'new-default');
  assert.match(ui.lastFrame()!, /Model: fixture\/chat/);
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
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
  const expected = await readFile(new URL('../expected/input-edit.txt', import.meta.url), 'utf8');
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
  assert.match(ui.lastFrame()!, /Copy mode/);
  await press('\x13');
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
  const expected = await readFile(new URL('../expected/history-navigation.txt', import.meta.url), 'utf8');
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
  const { CostLedger, costRecords } = await import('../../src/cost/index.ts');
  const fixture = await host(); t.after(() => fixture.close());
  const ledger = new CostLedger();
  const recording = (await readFile(new URL('../fixtures/workspace-edit.session.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => object(JSON.parse(line)));
  await ledger.replace('s1', recording.length - 2, costRecords(recording.slice(1).map((event, seq) => ({ type: 'event', event: { ...event, seq } }))));
  // Retain the recorded usage while this test exercises the terminal command.
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, ledger);
  controller.refreshCosts = async () => {};
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  await pressKey(ui, '/cost'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Cost · CNY estimate') === true);
  const expected = await readFile(new URL('../expected/cost.txt', import.meta.url), 'utf8');
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
  await until(() => ui.lastFrame()?.includes('First conversation') === true);
  fixture.control({ type: 'projection', sessionId: 's1', key: 'title', seq: 1, value: { title: 'Readable session title' } });
  await until(() => ui.lastFrame()?.includes('Readable session title') === true);
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

test('/think lists prompt summaries, expands the selected thought, and supports folding it again', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
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

test('a slash-command panel stays open for reading and closes on another command', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} panelLifetimeMs={150} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  Object.defineProperty(ui.stdout, 'rows', { value: 60, configurable: true });
  controller.start();
  await until(() => controller.state.transcript.ready);
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('/ws [name or ID]') === true);
  // Every advertised command shows its one-line description.
  const helpFrame = ui.lastFrame()!;
  for (const hint of COMMAND_HINTS) {
    assert.ok(helpFrame.includes(hint.command) && helpFrame.includes(hint.description), `${hint.command}: ${helpFrame}`);
  }
  await pressKey(ui, '/status'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Session ID: s1') === true);
  // The next command replaced the previous panel.
  assert.equal(ui.lastFrame()!.includes('/ws [name or ID]'), false);
  // Background timers do not dismiss a panel while the user is reading or copying.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.match(ui.lastFrame()!, /Session ID: s1/);
  await pressKey(ui, '/help'); await pressKey(ui, '\r');
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
  const { CostLedger, costRecords } = await import('../../src/cost/index.ts');
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
  assert.match(bar(), /! ● Ready/);
  assert.match(bar(), /\?\/~¥0\.00(?!\*)/);
  await ledger.replace('s1', 1, costRecords([{ type: 'event', event: { seq: 0, time: Date.parse('2026-09-10T10:00:00+08:00'),
    type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } } }]));
  // Charges cached by an earlier run already cover the history, so the bar stops warning.
  const cached = bar();
  assert.doesNotMatch(cached, /! ● Ready/);
  assert.match(cached, /~¥2\.00\//);
  assert.match(bar(true), /Cost \(CNY estimate\): Session ~¥2\.0000/);
  ledger.error = 'scan failed';
  assert.match(bar(), /! ● Ready/);
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

test('title and status fit terminal widths and keep model alignment when working completes', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  const controller = new Controller('http://x1:4096', undefined);
  controller.state = { ...controller.state, online: true, status: 'Connected', sessionId: 's1', screen: 'chat',
    sessions: [{ sessionId: 's1', running: true }], workspaceId: 'w1',
    workspaces: [{ workspaceId: 'w1', title: 'Workspace 示例', path: '/workspace' }] };
  controller.state.transcript.addPage({ records: [{ type: 'event', event: { seq: 0, type: 'turn/start', time: Date.now() - 8000, data: { turn: 42 } } }], hasMore: false });
  controller.telemetry.accept({ type: 'baseline', value: { projections: { s1: { asOfSeq: 0, values: {
    title: { title: '中文会话标题'.repeat(20) },
    modelSelection: { next: { provider: 'p', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } },
    sessionStats: { turns: 42 }, contextPressure: { projectedTokens: 25, contextWindow: 100 },
    tokenUsage: { uncachedInputTokens: 166_200_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } } }, queues: {}, jobs: {} } });
  let ui!: ReturnType<typeof render>;
  await act(async () => { ui = render(<App controller={controller} />); });
  t.after(() => { ui.unmount(); ui.cleanup(); });
  let columns = 140;
  Object.defineProperty(ui.stdout, 'columns', { get: () => columns });
  const refresh = async () => { await act(async () => { ui.rerender(<App controller={controller} />); }); };
  await refresh();
  assert.match(ui.lastFrame()!.split('\n')[0]!, /^\s*中文会话标题/);
  const working = ui.lastFrame()!.split('\n').find(line => line.includes('◐ Working'))!;
  assert.match(working, /◐ Working · 8s · Ctrl\+C Stop.*v4.1-flash · high.*███░░░░░░░ ~25%.*42 turns · 166.2M tok/);
  controller.state = { ...controller.state, version: 1, sessions: [{ sessionId: 's1', running: false }] };
  await refresh();
  const ready = ui.lastFrame()!.split('\n').find(line => line.includes('● Ready'))!;
  assert.equal(ready.indexOf('v4.1-flash'), working.indexOf('v4.1-flash'));
  assert.doesNotMatch(ready, /Working|Ctrl\+C Stop/);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  await pressKey(ui, '/think'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('No reasoning in loaded history') === true);
  assert.equal(fixture.calls.some(call => call.method === 'session/page'), false);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('#1 User · Older prompt') === true);
  assert.equal(fixture.calls.filter(call => call.method === 'session/page').length, 1);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Reasoning history · User prompts') === false);
  assert.ok(ui.lastFrame()?.includes('Older thought detail'));
  fixture.follow({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  fixture.follow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', index: 0, revision: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'Current thought detail' } } });
  fixture.follow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', index: 1, revision: 3, chunk: { type: 'text-delta', index: 1, text: 'Answer' } } });
  await until(() => controller.state.transcript.liveParts(80).length === 2);
  await pressKey(ui, '/think'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Now · User · Current prompt') === true);
  await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Reasoning history · User prompts') === false);
  assert.ok(ui.lastFrame()?.includes('Current thought detail'));
});

test('long conversations keep the header visible and show keyboard help only when requested', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  const live = controller.state.transcript;
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
  assert.equal(controller.state.transcript, live);
});


test('/model uses the host catalog and exact model/effort selection API', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.modelCatalog = { routableProviders: ['route'], failures: [{ id: 'broken', name: 'Broken provider', message: 'offline' }], groups: [
    { id: 'route', name: 'Provider', models: [{ id: 'model-x', name: 'Model X', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } }] },
  ] };
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
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
  await until(() => !controller.state.busy);
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
  await assert.rejects(controller.selectModel('route', 'missing'), /busy/);
  assert.equal(object(controller.telemetry.view('s1').values.modelSelection).next !== null, true);
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
  await until(() => !controller.state.busy);
  await pressKey(ui, '/model route model-x high'); await pressKey(ui, '\r');
  await until(() => fixture.calls.filter(call => call.method === 'session/selectModel').length === 4);
});


test('workspace removal and session archival require confirmation and preserve host history', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  const command = async (value: string) => { await pressKey(ui, value); await pressKey(ui, '\r'); await until(() => !controller.state.busy); };
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
  const old = controller.state.transcript;
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'workspace/archiveSession') && !controller.state.busy);
  assert.equal(controller.visibleSessions.some(row => row.sessionId === 's1'), false);
  assert.equal(old.retainedRecordCount, 0);
  await command('/resume all');
  assert.equal(controller.visibleSessions.some(row => row.sessionId === 's1'), false);
  await command('/resume s1');
  await until(() => controller.state.transcript.ready);
  assert.equal(controller.state.sessionId, 's1');
  await command('/ws --delete w1');
  await until(() => ui.lastFrame()?.includes('Remove workspace registration?') === true);
  fixture.businessError = true;
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\r');
  await until(() => !controller.state.busy && controller.state.error.includes('busy'));
  assert.equal(controller.state.workspaces.length, 1);
  assert.match(ui.lastFrame()!, /Remove workspace registration/);
  fixture.businessError = false;
  await pressKey(ui, '\r');
  await until(() => controller.state.workspaces.length === 0 && !controller.state.busy);
  assert.equal(controller.state.sessionId, 's1');
  assert.equal(controller.state.transcript.ready, true);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});


test('empty sessions archive without confirmation after a fresh blank-state check', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.blank = true;
  fixture.followSnapshot = { type: 'snapshot', cursor: 0, hasMore: false, header: { id: 's1' }, records: [], assistantStream: { revision: 0 } };
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  await pressKey(ui, '/resume'); await pressKey(ui, '\r');
  await until(() => controller.state.screen === 'sessions' && !controller.state.busy);
  await pressKey(ui, '\u001b[B'); // Skip New session.
  fixture.blank = false; // The picker is stale; the removal read must observe this change.
  await pressKey(ui, 'd');
  await until(() => ui.lastFrame()?.includes('Archive session?') === true);
  assert.equal(fixture.calls.some(call => call.method === 'workspace/archiveSession'), false);
  await pressKey(ui, '\x1b');
  fixture.blank = true;
  await pressKey(ui, '/resume --delete s1'); await pressKey(ui, '\r');
  await until(() => fixture.calls.some(call => call.method === 'workspace/archiveSession') && !controller.state.busy);
  assert.doesNotMatch(ui.lastFrame()!, /Archive session\?/);
  assert.equal(controller.visibleSessions.some(row => row.sessionId === 's1'), false);
});


test('copy mode freezes streaming and clocks; dialogs freeze their background until closed', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => ui.lastFrame()?.includes('Working') === true);
  await pressKey(ui, '/copy'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Copy mode') === true);
  const frozen = ui.lastFrame();
  fixture.follow({ type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: 'Arrived during copy' }] } } });
  await until(() => controller.state.transcript.messages.some(message => message.text.includes('Arrived during copy')));
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
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
  await until(() => controller.state.error.includes('busy') && !controller.state.busy);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  Object.defineProperty(ui.stdout, 'columns', { value: 180, configurable: true });
  Object.defineProperty(ui.stdout, 'rows', { value: 28, configurable: true });
  controller.start(); await until(() => controller.state.transcript.ready && ui.lastFrame()?.includes('Commit locally?') === true);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  for (const text of ['first prompt', 'second prompt']) {
    await pressKey(ui, text); await pressKey(ui, '\r');
    await until(() => !controller.state.busy);
  }
  await pressKey(ui, 'unfinished draft');
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ second prompt/);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ first prompt/);
  await pressKey(ui, '\u001b[B'); assert.match(ui.lastFrame()!, /❯ second prompt/);
  await pressKey(ui, '\u001b[B'); assert.match(ui.lastFrame()!, /❯ unfinished draft/);
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 2);
  await pressKey(ui, '\x03');
  await pressKey(ui, '/latest'); await pressKey(ui, '\r');
  await until(() => !controller.state.busy);
  await pressKey(ui, '\x10'); assert.match(ui.lastFrame()!, /❯ \/latest/);
  await pressKey(ui, '\x0e'); assert.doesNotMatch(ui.lastFrame()!, /❯ \/latest/);
  await pressKey(ui, '\u001b[A'); await pressKey(ui, ' edited');
  await pressKey(ui, '\u001b[B'); assert.match(ui.lastFrame()!, /❯ \/latest edited/);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  await pressKey(ui, 'unsent draft');
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ latest saved prompt/);
  await pressKey(ui, '\u001b[A'); assert.match(ui.lastFrame()!, /❯ 你好/);
  await pressKey(ui, '\u001b[B'); await pressKey(ui, '\u001b[B');
  assert.match(ui.lastFrame()!, /❯ unsent draft/);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});


test('left click freezes the display for native selection until explicit resume', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => ui.lastFrame()?.includes('Working') === true);
  for (const report of ['\x1b[<2;3;4M', '\x1b[<0;3;4m', '\x1b[<32;3;4M']) {
    await pressKey(ui, report); assert.doesNotMatch(ui.lastFrame()!, /Copy mode/);
  }
  await pressKey(ui, '\x1b[<0;3;4M');
  assert.match(ui.lastFrame()!, /Copy mode/);
  const frozen = ui.lastFrame();
  fixture.follow({ type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text: 'Received while selecting' }] } } });
  await until(() => controller.state.transcript.messages.some(message => message.text.includes('Received while selecting')));
  await pressKey(ui, '\x1b[<0;3;4m');
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(ui.lastFrame(), frozen);
  await pressKey(ui, '\x03');
  await until(() => ui.lastFrame()?.includes('Received while selecting') === true);
  assert.doesNotMatch(ui.lastFrame()!, /Copy mode/);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});

test('/compact displays host progress and outcomes without sending a prompt', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  let complete!: (value: ObjectValue) => void;
  fixture.onCommand = () => new Promise(resolve => { complete = resolve; });
  await pressKey(ui, '/compact'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Compacting history…') === true && !!complete);
  complete({ commandId: 'c1', result: { kind: 'success', text: 'Compacted 8 history items (~1200 tokens).' } });
  await until(() => !controller.state.busy && ui.lastFrame()?.includes('Compacted 8 history items') === true);
  assert.doesNotMatch(ui.lastFrame()!, /❯ \/compact/);
  fixture.onCommand = async () => ({ commandId: 'c2', result: { kind: 'error', text: 'Compaction is unavailable: agent is not idle.' } });
  await pressKey(ui, '/compact'); await pressKey(ui, '\r');
  await until(() => !controller.state.busy && controller.state.error.includes('not idle'));
  assert.match(ui.lastFrame()!, /❯ \/compact/);
  fixture.onCommand = async () => undefined;
  await pressKey(ui, '\r');
  await until(() => controller.state.error.includes('does not provide /compact'));
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('Esc cancels the compact request and retains the command draft', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  let complete!: (value: ObjectValue) => void;
  fixture.onCommand = () => new Promise(resolve => { complete = resolve; });
  t.after(async () => { complete?.({ commandId: 'c1', result: { kind: 'error', text: 'Compaction cancelled.' } }); ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  await pressKey(ui, '/compact'); await pressKey(ui, '\r');
  await until(() => !!complete && controller.state.busy);
  await pressKey(ui, '\u001b');
  await until(() => !controller.state.busy);
  assert.match(ui.lastFrame()!, /❯ \/compact/);
  assert.doesNotMatch(ui.lastFrame()!, /Compacting history…/);
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
});

test('narrow terminals fold streaming reasoning until /think live opens it', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  Object.defineProperty(ui.stdout, 'columns', { value: 40, configurable: true });
  controller.start(); await until(() => controller.state.transcript.ready);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.running);
  for (const line of ['/plan outline this change', '/plan off', '/goal finish the task', '/goal pause', '/goal resume', '/permission workspace-write', '/feedback useful result']) {
    await pressKey(ui, line); await pressKey(ui, '\r');
    await until(() => !controller.state.busy && ui.lastFrame()?.includes(`Completed ${line}`) === true);
    assert.equal(object(object(fixture.calls.filter(call => call.method === 'commands/execute').at(-1)!.payload).args).line, line);
  }
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
  fixture.onCommand = async () => ({ commandId: 'command-2', result: { kind: 'error', text: 'Unknown permission preset' } });
  await pressKey(ui, '/permission nope'); await pressKey(ui, '\r');
  await until(() => controller.state.error.includes('Unknown permission preset'));
  assert.match(ui.lastFrame()!, /❯ \/permission nope/);
  assert.ok(!COMMAND_HINTS.some(hint => hint.command === '/steer'));
});

test('working input automatically steers, stays inside the composer, and can be removed', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  await pressKey(ui, 'start this task'); await pressKey(ui, '\r');
  await until(() => !controller.state.busy);
  fixture.queuePrompts = true;
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.running);
  for (const text of ['also check tests', 'skip the build']) {
    await pressKey(ui, text); await pressKey(ui, '\r');
    await until(() => !controller.state.busy && controller.telemetry.pending('s1').some(item => item.text === text));
  }
  const modes = fixture.calls.filter(call => call.method === 'session/prompt').map(call => object(object(object(call.payload).args).request).mode);
  assert.deepEqual(modes, ['queue', 'steer', 'steer']);
  assertInsideComposer(ui.lastFrame()!, 'also check tests');
  assertInsideComposer(ui.lastFrame()!, 'skip the build');
  for (const line of (await readFile(new URL('../expected/pending-input.txt', import.meta.url), 'utf8')).trimEnd().split('\n')) assert.ok(ui.lastFrame()!.includes(line), ui.lastFrame());
  const pending = controller.telemetry.pending('s1');
  await pressKey(ui, '/queue'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Pending input · Esc close') === true);
  await pressKey(ui, '\u001b[B'); await pressKey(ui, 'd');
  await until(() => !controller.state.busy && controller.telemetry.pending('s1').length === 1);
  assert.equal(controller.telemetry.pending('s1')[0]!.id, pending[0]!.id);
  const request = object(object(object(fixture.calls.find(call => call.method === 'session/updateQueue')!.payload).args).request);
  assert.deepEqual(request, { sessionId: 's1', itemId: pending[1]!.id, action: { kind: 'remove' } });
  await pressKey(ui, '\u001b');
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
  fixture.control({ type: 'queue', sessionId: 's1', items: [] });
  await until(() => !ui.lastFrame()?.includes('Waiting:'));
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 3);
});

test('questions and approvals take precedence over the pending-input picker', async t => {
  const fixture = await host(); t.after(() => fixture.close()); fixture.queuePrompts = true;
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.running);
  await pressKey(ui, 'pending instruction'); await pressKey(ui, '\r');
  await until(() => !controller.state.busy && controller.telemetry.pending('s1').length === 1);
  await pressKey(ui, '/queue'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Pending input · Esc close') === true);
  fixture.emit({ type: 'waterfall', event: 'user-questions/request', eventId: 'question-with-queue', agentId: 's1', request: { questions: [
    { id: 'q', question: 'Choose an action', options: [{ label: 'Keep' }, { label: 'Change' }] },
  ] } });
  await until(() => ui.lastFrame()?.includes('Choose an action') === true);
  await assert.rejects(controller.prompt('stale composer submission'), /pending question or approval/);
  await pressKey(ui, '2'); await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0 && !controller.state.busy);
  const answer = object(object(fixture.calls.filter(call => call.method === '$events/result').at(-1)!.payload).args);
  assert.deepEqual(object(answer.outcome).value, { answers: [{ id: 'q', selected: ['Change'] }] });
  fixture.emit({ type: 'waterfall', event: 'approval/request', eventId: 'approval-with-queue', agentId: 's1', request: { description: 'Confirm operation' } });
  await until(() => ui.lastFrame()?.includes('Approval required') === true);
  await pressKey(ui, '/allow'); await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0 && !controller.state.busy);
  const approval = object(object(fixture.calls.filter(call => call.method === '$events/result').at(-1)!.payload).args);
  assert.equal(object(approval.outcome).value, 'allowed-once');
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
  assert.equal(fixture.calls.some(call => call.method === 'session/updateQueue'), false);
  assert.equal(controller.telemetry.pending('s1').length, 1);
});

test('help pages keep later slash commands accessible in a short terminal', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  Object.defineProperty(ui.stdout, 'rows', { value: 20, configurable: true });
  controller.start(); await until(() => controller.state.transcript.ready);
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
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  t.after(async () => { ui.unmount(); ui.cleanup(); await controller.stop(); });
  controller.start(); await until(() => controller.state.transcript.ready);
  await pressKey(ui, `/export "${path}"`); await pressKey(ui, '\r');
  await until(() => !controller.state.busy && ui.lastFrame()?.includes('Saved session log:') === true);
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('questions, approvals and model dialogs retain recent context above the composer', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 12, hasMore: false, header: { id: 's1' }, assistantStream: { revision: 0 }, records: [
    ...Array.from({ length: 12 }, (_, seq) => ({ type: 'event', event: { type: 'user/message', seq, surfaceOp: 'append', data: { content: [{ type: 'text', text: `Earlier context ${seq}` }] } } })),
    { type: 'event', event: { type: 'assistant/message', seq: 12, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'Recent decision context' }] } } } },
  ] };
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
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
  await until(() => controller.state.pending.length === 0 && !controller.state.busy);
  fixture.emit({ type: 'waterfall', event: 'approval/request', eventId: 'context-approval', agentId: 's1', request: { description: 'Confirm operation' } });
  await until(() => ui.lastFrame()?.includes('Approval required') === true);
  assert.match(ui.lastFrame()!, /Recent decision context/);
  await pressKey(ui, '/deny'); await pressKey(ui, '\r');
  await until(() => controller.state.pending.length === 0 && !controller.state.busy);
  await pressKey(ui, '/model'); await pressKey(ui, '\r');
  await until(() => ui.lastFrame()?.includes('Choose model') === true);
  assert.match(ui.lastFrame()!, /Recent decision context/);
});
