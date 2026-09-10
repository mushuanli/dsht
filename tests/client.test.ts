/** Real HTTP/WS transport and controller lifecycle tests with no model credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, RemoteError } from '../src/client.ts';
import { Controller } from '../src/controller.ts';
import { object } from '../src/wire.ts';
import { host, until } from './host.ts';

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
