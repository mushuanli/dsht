/** Real HTTP/WS transport and controller lifecycle tests with no model credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, RemoteError } from '../../src/transport/client.ts';
import { Controller } from '../../src/controller/controller.ts';
import { object } from '../../src/transport/wire.ts';
import { host, until, workspace } from '../support/host.ts';

test('lists workspaces and sessions over one authenticated mux, cancelling baseline streams', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const client = new Client(fixture.url); t.after(() => client.close());
  await client.authenticate('fixture-token');
  await client.connect();
  const workspaces = await client.listWorkspaces();
  assert.equal(workspaces[0]?.workspaceId, 'w1');
  assert.equal((await client.listSessions()).length, 2);
  assert.deepEqual((await client.listSessions('w1')).map(item => item.sessionId), ['s1']);
  await until(() => fixture.cancels.length === 2);
  assert.equal(new Set(fixture.opens.map(frame => frame.streamId)).size, fixture.opens.length);
  await assert.rejects(client.listSessions('missing'), /Workspace not found/);
});

test('rejects bad authentication, business failures, and mismatched response IDs', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const client = new Client(fixture.url); t.after(() => client.close());
  await assert.rejects(client.authenticate('wrong'), /HTTP 401/);
  await client.authenticate('fixture-token');
  fixture.businessError = true;
  await assert.rejects(client.listSessions(), (error: unknown) => error instanceof RemoteError && error.code === 'session/agent-busy');
  fixture.businessError = false;
  fixture.wrongIdentity = true;
  await assert.rejects(client.listSessions(), /identity mismatch/);
});

test('selected-session interaction replies and reconnection replace the baseline', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token'); t.after(() => controller.stop());
  controller.start();
  await until(() => controller.state.workspaces.length === 1);
  assert.equal(controller.state.screen, 'workspaces');
  assert.equal(fixture.calls.some(call => call.method === 'session/create'), false);
  controller.pickWorkspace('w1');
  assert.equal(controller.visibleSessions.length, 1);
  await controller.selectSession('s1');
  await until(() => controller.state.transcript.ready);
  await controller.prompt('hello');
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
  fixture.emit({ type: 'waterfall', event: 'unknown/request', eventId: 'other', agentId: 's1', request: {} });
  await until(() => fixture.calls.some(call => call.method === '$events/result'));
  assert.deepEqual(object(object(fixture.calls.at(-1)!.payload).args).outcome, { kind: 'next' });
  fixture.emit({ type: 'waterfall', event: 'approval/request', eventId: 'approval', agentId: 's1', request: { reason: 'execute' } });
  await until(() => controller.state.pending.length === 1);
  await controller.approve(false);
  assert.deepEqual(object(object(fixture.calls.at(-1)!.payload).args).outcome, { kind: 'result', value: 'rejected' });
  fixture.baseline = [];
  fixture.disconnect();
  await until(() => !controller.state.online);
  await until(() => controller.state.online && controller.state.transcript.ready && controller.state.workspaces.length === 0);
  assert.equal(controller.state.sessionId, 's1');
  assert.equal(controller.state.transcript.messages.length, 1);
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
});

test('logical stream errors settle and disconnected lists fail promptly', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const client = new Client(fixture.url); t.after(() => client.close());
  await assert.rejects(client.listWorkspaces(), /not connected/);
  await client.authenticate('fixture-token'); await client.connect();
  const error = await new Promise<Error | undefined>(resolve => client.subscribe('missing/stream', {}, { item() {}, end: resolve }));
  assert(error instanceof RemoteError);
  const callbackError = await new Promise<Error | undefined>(resolve => client.subscribe('workspace/follow', {}, {
    item() { throw new Error('callback failure'); }, end: resolve,
  }));
  assert.equal(callbackError?.message, 'callback failure');
  assert.equal((await client.listWorkspaces()).length, 1);
});

test('workspace and session commands switch across workspaces without creating or cancelling agents', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.baseline = [workspace, { ...workspace, workspaceId: 'w2', title: 'Project β', path: '/host/second', sessionIds: ['s2'] }];
  const controller = new Controller(fixture.url, 'fixture-token'); t.after(() => controller.stop());
  controller.start();
  await until(() => controller.state.workspaces.length === 2);
  await controller.switchSession();
  assert.equal(controller.state.screen, 'workspaces');
  await controller.switchWorkspace('Project α');
  assert.equal(controller.state.workspaceId, 'w1');
  await controller.switchSession();
  assert.equal(controller.state.screen, 'sessions');
  assert.deepEqual(controller.visibleSessions.map(item => item.sessionId), ['s1']);
  await controller.switchSession('all');
  assert.equal(controller.state.showAllSessions, true);
  assert.deepEqual(controller.visibleSessions.map(item => item.sessionId), ['s1', 's2']);
  await controller.switchSession();
  assert.equal(controller.state.showAllSessions, false);
  assert.equal(controller.visibleSessions.length, 1);
  await controller.switchSession('First conversation');
  await until(() => controller.state.transcript.ready);
  await controller.switchSession('s2');
  assert.equal(controller.state.workspaceId, 'w2');
  assert.equal(controller.state.sessionId, 's2');
  await assert.rejects(controller.switchSession('s'), /Ambiguous/);
  assert.equal(controller.state.sessionId, 's2');
  await controller.switchWorkspace('/host/project');
  assert.equal(controller.state.sessionId, undefined);
  assert.equal(controller.state.screen, 'sessions');
  assert(!fixture.calls.some(call => call.method === 'session/create' || call.method === 'session/cancel'));
});

test('cancelling one unary lookup leaves subsequent authenticated requests usable', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const client = new Client(fixture.url); t.after(() => client.close());
  await client.authenticate('fixture-token');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(client.call('fileReferences/list', { agentId: 's1', query: '' }, abort.signal), { name: 'AbortError' });
  assert.deepEqual(await client.call('fileReferences/list', { agentId: 's1', query: 'src/' }),
    [{ path: 'src/hello world.ts', kind: 'file' }]);
});

test('interrupt cancels a running selected session, coalesces repeated keys, and exits only after idle', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  t.after(() => controller.stop());
  controller.start();
  await until(() => controller.state.transcript.ready);
  assert.equal(await controller.interrupt(), true);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => controller.running);
  let release!: () => void;
  fixture.onCancel = () => new Promise<void>(resolve => { release = resolve; });
  t.after(() => release?.());
  const first = controller.interrupt();
  assert.equal(controller.interrupt(), first);
  await until(() => release !== undefined);
  assert.equal(fixture.calls.filter(call => call.method === 'session/cancel').length, 1);
  release();
  assert.equal(await first, false);
  assert.equal(controller.running, true);
  fixture.onCancel = undefined;
  fixture.businessError = true;
  assert.equal(await controller.interrupt(), false);
  assert.match(controller.state.error, /session\/agent-busy/);
  fixture.businessError = false;
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => !controller.running);
  assert.equal(await controller.interrupt(), true);
  await controller.selectSession('s2');
  assert.equal(controller.running, true);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s2', false] });
  await until(() => !controller.running);
  assert.equal(await controller.interrupt(), true);
});

test('Ctrl+C during prompt admission waits for admission before sending cancellation', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  t.after(() => controller.stop());
  controller.start();
  await until(() => controller.state.transcript.ready);
  let release!: () => void;
  fixture.onPrompt = () => new Promise<void>(resolve => { release = resolve; });
  t.after(() => release?.());
  const prompt = controller.prompt('work');
  await until(() => release !== undefined);
  const interrupt = controller.interrupt();
  assert.equal(fixture.calls.some(call => call.method === 'session/cancel'), false);
  release();
  await prompt;
  assert.equal(await interrupt, false);
  assert.equal(fixture.calls.at(-1)?.method, 'session/cancel');
});


test('replayed questions survive startup, picker navigation and reconnect without declining the request', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const frame = { type: 'waterfall', event: 'user-questions/request', eventId: 'question-1', agentId: 's1',
    request: { questions: [{ id: 'q1', question: 'Two decisions before I commit', options: [{ label: 'Review first' }] }] } };
  fixture.replayInteractions = [frame];
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  t.after(() => controller.stop());
  controller.start();
  await until(() => controller.state.transcript.ready && controller.state.pending.length === 1);
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
  await controller.showPicker('workspaces');
  assert.equal(controller.state.pending.length, 0);
  await controller.selectSession('s1');
  await until(() => controller.state.pending.length === 1);
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
  fixture.disconnect();
  await until(() => !controller.state.online);
  await until(() => controller.state.online && controller.state.transcript.ready && controller.state.pending.length === 1);
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
  await controller.answer({ answers: [{ id: 'q1', selected: ['Review first'] }] });
  assert.equal(controller.state.pending.length, 0);
  const reply = object(object(fixture.calls.find(call => call.method === '$events/result')!.payload).args);
  assert.equal(object(reply.outcome).kind, 'result');
});

test('long command calls can outlive the default timeout and remain cancellable', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const client = new Client(fixture.url); t.after(() => client.close());
  await client.authenticate('fixture-token');
  Object.defineProperty(client, 'timeoutMs', { value: 10 });
  fixture.onCommand = async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return { commandId: 'c1', result: { kind: 'success', text: 'No compactable history yet.' } };
  };
  const args = { agentId: 's1', line: '/compact', submittedAttachments: [] };
  await assert.rejects(client.call('commands/execute', args), { name: 'TimeoutError' });
  const result = await client.call('commands/execute', args, undefined, null);
  assert.equal(object(object(result).result).text, 'No compactable history yet.');
  const abort = new AbortController();
  const request = client.call('commands/execute', args, abort.signal, null);
  abort.abort();
  await assert.rejects(request, { name: 'AbortError' });
});

test('a claimed queue item cannot be removed or resubmitted by a stale action', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1'); t.after(() => controller.stop());
  controller.start(); await until(() => controller.state.transcript.ready);
  await assert.rejects(controller.removeQueued('already-claimed'), error => error instanceof RemoteError && error.code === 'session/queue-item-not-found');
  assert.equal(fixture.calls.filter(call => call.method === 'session/updateQueue').length, 1);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});
