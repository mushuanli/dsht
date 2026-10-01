/** A submitted prompt stays visible until the host has it, however the host reports that. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller/controller.ts';
import { object } from '../../src/transport/wire.ts';
import { host, snapshot, until } from '../support/host.ts';

/** Mount a connected controller on `s1`; the caller owns both through `t.after`. */
async function mount(t: { after(fn: () => void | Promise<void>): void }) {
  const fixture = await host();
  t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.queries.connectionSettled && controller.queries.record.ready);
  return { fixture, controller };
}

/** The request id the host will echo as the user message's `source.rpcId`. */
function lastRequestId(fixture: Awaited<ReturnType<typeof host>>): string {
  const call = fixture.calls.filter(candidate => candidate.method === 'session/prompt').at(-1)!;
  return String(object(object(object(call.payload).args).request).requestId);
}

test('a submitted prompt is listed until the durable echo carries its identity', async t => {
  const { fixture, controller } = await mount(t);
  assert.equal(await controller.actions.prompt('steer this turn'), true);
  assert.deepEqual(controller.queries.pendingPrompts.map(item => item.text), ['steer this turn']);
  // The host writes a steering message into the session only at the next step boundary, so the row
  // has to survive the wait and leave exactly when that row appears.
  const rpcId = lastRequestId(fixture);
  fixture.follow({ type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text: 'steer this turn' }], source: { kind: 'user', rpcId } } } });
  await until(() => controller.queries.pendingPrompts.length === 0);
});

test('a host that records the submission in its inbox retires the row without waiting for the echo', async t => {
  const { controller, fixture } = await mount(t);
  // The fixture splices the submission into its durable inbox and publishes that projection with the
  // submission's own rpcId, which is the host saying it now holds the message; a client that ignored
  // it would show the line twice.
  fixture.queuePrompts = true;
  assert.equal(await controller.actions.prompt('queued for the next step'), true);
  await until(() => controller.queries.pendingPrompts.length === 0);
});

test('a host that still reports the retired queue section retires the row on its own report', async t => {
  const { controller, fixture } = await mount(t);
  assert.equal(await controller.actions.prompt('steer the next step'), true);
  await until(() => controller.queries.pendingPrompts.length === 1);
  const rpcId = lastRequestId(fixture);
  // A host at 0.1.5 or older reports pending input on `session/control` instead of the inbox projection.
  fixture.control({ type: 'queue', sessionId: 's1', items: [{ id: 'm-1', placement: 'steering', rpcId,
    message: { id: 'm-1', content: [{ type: 'text', text: 'steer the next step' }] } }] });
  await until(() => controller.queries.pendingPrompts.length === 0);
});

test('a rejected submission leaves no row behind', async t => {
  const { controller, fixture } = await mount(t);
  fixture.businessError = true;
  assert.equal(await controller.actions.prompt('this one is refused'), false);
  assert.deepEqual(controller.queries.pendingPrompts, []);
});

test('a prompt the client assembled is not shown as the operator\'s own', async t => {
  const { controller } = await mount(t);
  // Loop briefs and handoffs are sent through the same write, but nobody typed them; the composer
  // must not claim them as a pending submission.
  await controller.session.promptInternal('loop brief');
  assert.deepEqual(controller.queries.pendingPrompts, []);
});

test('a pending submission does not follow the reader into another session', async t => {
  const { controller } = await mount(t);
  assert.equal(await controller.actions.prompt('belongs to s1'), true);
  await controller.actions.selectSession('s2');
  assert.deepEqual(controller.queries.pendingPrompts, []);
});

test('a 0.2 surface rewrite in the snapshot opens the session instead of restarting the connection', async t => {
  const fixture = await host();
  t.after(() => fixture.close());
  // The record shape a 0.2 host writes when it re-surfaces an older tool result, plus a call whose
  // answer arrives through the rewrite: reading `data` on the reduced event is what used to throw
  // "Expected a JSON object from the server" and tear the generation down in a loop.
  fixture.followSnapshot = { ...snapshot, records: [
    { type: 'event', event: { seq: 0, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: '你好' }] } } },
    { type: 'event', event: { seq: 1, type: 'turn/start', time: 1_000, data: { turn: 1 } } },
    { type: 'event', event: { seq: 2, type: 'assistant/message', surfaceOp: 'append', time: 1_100,
      data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } } } },
    { type: 'event', event: { seq: 9, type: 'tool/result', surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, time: 1_200,
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: false }] } } } },
    // A record with no payload at all: retained for its identity, read by nobody.
    { type: 'event', event: { seq: 10, type: 'tool/result', time: 1_300 } },
  ] };
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  assert.equal(controller.state.lastFailure, '');
  assert.equal(controller.queries.record.runningTool, undefined);
  // One generation is enough: a decode failure would have shown up as a reconnect (and as a second
  // login) before the snapshot was ever applied.
  assert.equal(fixture.loginCount, 1);
  assert.equal(controller.state.online, true);
});
