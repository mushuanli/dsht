/** A steering row the host never claimed is moved behind the turn boundary instead of waiting for one. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller/controller.ts';
import { array, object, type ObjectValue } from '../../src/transport/wire.ts';
import { host, until } from '../support/host.ts';

/** Start a controller on `s1` whose host reports every prompt in its durable inbox. */
async function mounted(t: { after(fn: () => void | Promise<void>): void }) {
  const fixture = await host();
  t.after(() => fixture.close());
  fixture.queuePrompts = true;
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await app.stop(); });
  app.start();
  await until(() => app.queries.record.ready);
  return { fixture, app };
}

/** Send one line as steering, the way an operator's message does while the agent works. */
async function steer(fixture: Awaited<ReturnType<typeof host>>, app: Controller) {
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  await until(() => app.queries.running);
  await app.actions.prompt('steer me');
  await until(() => app.queries.telemetry.pending('s1').some(item => item.placement === 'steering'));
}

/** One `session/prompt` request's delivery mode, in host order. */
const promptModes = (fixture: { calls: readonly ObjectValue[] }): unknown[] =>
  fixture.calls.filter(call => call.method === 'session/prompt')
    .map(call => object(object(object(call.payload).args).request).mode);

test('a steering row nothing will claim is re-queued when the turn ends', async t => {
  const { fixture, app } = await mounted(t);
  await steer(fixture, app);
  assert.deepEqual(promptModes(fixture), ['steer']);
  // The turn is cancelled before its next step boundary, which is the case that leaves the row behind:
  // the host is idle and will never wake for input parked in `next-step`.
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 2);
  // The parked row left the host's inbox, and the same text came back as a queued turn, which is what
  // the host does wake for.
  const removed = fixture.calls.filter(call => call.method === 'session/updateQueue');
  assert.equal(removed.length, 1);
  const change = object(object(removed[0]!.payload).args).request;
  assert.deepEqual(object(change).action, { kind: 'remove' });
  assert.deepEqual(promptModes(fixture), ['steer', 'queue']);
  const request = object(object(object(fixture.calls.filter(call => call.method === 'session/prompt').at(-1)!.payload).args).request);
  assert.equal(array(request.content).map(part => object(part).text).join(''), 'steer me');
  await until(() => app.queries.telemetry.pending('s1').some(item => item.placement === 'queued'));
  assert.equal(app.queries.telemetry.pending('s1').some(item => item.placement === 'steering'), false);
});

test('a row the host already claimed is delivery, not a second copy', async t => {
  const { fixture, app } = await mounted(t);
  await steer(fixture, app);
  // The host claims the row without publishing the change, so this client still reads the projection
  // that lists it — the exact race the move has to lose safely.
  fixture.staleInbox = { 'next-step': [], 'next-turn': [] };
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => fixture.calls.some(call => call.method === 'session/updateQueue'));
  // The host's answer says the row is gone, so the message was delivered and nothing is re-sent.
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
  // A later publish does not ask again: the claim is remembered, not re-derived from a stale list.
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fixture.calls.filter(call => call.method === 'session/updateQueue').length, 1);
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
});

test('a refused move keeps the text and retries it', async t => {
  const { fixture, app } = await mounted(t);
  await steer(fixture, app);
  // The host refuses the queue mutation without applying it, so the row is still there and the text is
  // still the host's; the move failed and has to be retried rather than treated as delivered.
  fixture.failQueueRemoval = true;
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => app.state.lastFailure.includes('agent-busy'));
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
  assert.equal(app.queries.telemetry.pending('s1').some(item => item.placement === 'steering'), true);
  // Once the host accepts again, the publish after the retry window moves the row.
  fixture.failQueueRemoval = false;
  await new Promise(resolve => setTimeout(resolve, 1100));
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 2);
  assert.deepEqual(promptModes(fixture), ['steer', 'queue']);
});

test('the move waits for the turn boundary', async t => {
  const { fixture, app } = await mounted(t);
  await steer(fixture, app);
  // The host still reports the turn running: a running turn claims the row itself at its next step
  // boundary, so moving it now would race that claim. Only a publish that reports the client free lets
  // the move run.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fixture.calls.some(call => call.method === 'session/updateQueue'), false);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => fixture.calls.some(call => call.method === 'session/updateQueue'));
});
