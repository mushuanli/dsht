/** The client-driven `/design-review` loop, driven end to end against the host fixture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller/index.ts';
import { array, object } from '../../src/transport/wire.ts';
import { host, until } from '../support/host.ts';

/** Text of the newest `session/prompt` request. */
function lastPrompt(fixture: Awaited<ReturnType<typeof host>>): string {
  const call = fixture.calls.filter(entry => entry.method === 'session/prompt').at(-1)!;
  return String(object(array(object(object(object(call.payload).args).request).content)[0]).text);
}

/** Push one durable assistant reply through the follow stream. */
function reply(fixture: Awaited<ReturnType<typeof host>>, seq: number, text: string): void {
  fixture.follow({ type: 'event', event: { seq, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text }] } } } });
}

/** Report the reviewed session idle, which is the signal the loop waits for. */
function idle(fixture: Awaited<ReturnType<typeof host>>): void {
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
}

test('the loop sends the brief, advances on a passing score and stops on a failing round', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  assert.equal(await controller.actions.startReview({ from: 1, to: 2, score: 8, tries: 2 }), true);
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  // The opening send is the scoped brief, not a follow-up.
  assert.match(lastPrompt(fixture), /只执行第 1 轮的第 1 次尝试/);
  assert.deepEqual(controller.queries.review, {
    from: 1, to: 2, score: 8, tries: 2, round: 1, attempt: 1, best: 0, phase: 'reviewing' });

  // A passing score advances to round 2 with a short follow-up.
  reply(fixture, 10, 'findings…\n```dsht-review\n{"round":1,"attempt":1,"score":8.5}\n```');
  await until(() => controller.queries.record.messages.some(message => message.text.includes('dsht-review')));
  idle(fixture);
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 2);
  assert.match(lastPrompt(fixture), /现在是第 2 轮、第 1\/2 次尝试/);
  assert.equal(controller.queries.review?.round, 2);

  // A low score costs one attempt, and exhausting the budget stops the run.
  reply(fixture, 11, 'still weak\n```dsht-review\n{"round":2,"attempt":1,"score":7}\n```');
  await until(() => controller.queries.record.messages.length > 2);
  idle(fixture);
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 3);
  assert.match(lastPrompt(fixture), /现在是第 2 轮、第 2\/2 次尝试/);

  reply(fixture, 12, 'no block at all');
  await until(() => controller.queries.record.messages.length > 3);
  idle(fixture);
  await until(() => controller.queries.review?.phase === 'exhausted');
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 3);
  assert.equal(controller.queries.review?.best, 7);
});

test('typed text, an explicit stop and a session switch all end the loop', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startReview({});
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  assert.equal(controller.queries.review?.phase, 'reviewing');
  // A human turn takes the conversation back, so the loop stops instead of racing it.
  await controller.actions.prompt('never mind');
  assert.equal(controller.queries.review?.phase, 'cancelled');

  await controller.actions.startReview({});
  assert.equal(controller.queries.review?.phase, 'reviewing');
  controller.actions.stopReview();
  assert.equal(controller.queries.review?.phase, 'cancelled');

  // A review belongs to its session, so opening another one drops it entirely.
  await controller.actions.startReview({});
  assert.equal(controller.queries.review?.round, 1);
  await controller.actions.selectSession('s2');
  await until(() => controller.state.sessionId === 's2');
  assert.equal(controller.queries.review, undefined);
});
