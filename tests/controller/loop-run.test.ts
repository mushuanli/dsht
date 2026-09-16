/** The client-driven loop, driven end to end against the host fixture through one protocol. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller, designReviewProtocol } from '../../src/controller/index.ts';
import { array, object } from '../../src/transport/wire.ts';
import { host, until, workspace } from '../support/host.ts';

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

/** Report the reviewed session idle, the way the host does: busy first, then idle. */
function idle(fixture: Awaited<ReturnType<typeof host>>): void {
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
}

const block = (step: number, attempt: number, score: number | string) =>
  '```dsht-loop\n' + JSON.stringify({ kind: 'design-review', step, attempt, score }) + '\n```';

test('the loop sends the brief, advances on a passing score and stops on a failing step', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  assert.equal(await controller.actions.startLoop(designReviewProtocol(), { from: 1, to: 2, score: 8, tries: 2 }), true);
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  // The opening send is the scoped brief, not a follow-up.
  assert.match(lastPrompt(fixture), /只执行第 1 轮的第 1 次尝试/);
  assert.deepEqual(controller.queries.loop, {
    title: 'Design review', from: 1, to: 2, score: 8, tries: 2, step: 1, attempt: 1, best: 0, phase: 'running', stepLabel: '职责与归属' });

  // A passing score advances to step 2 with a short follow-up.
  reply(fixture, 10, 'findings…\n' + block(1, 1, 8.5));
  await until(() => controller.queries.record.messages.some(message => message.text.includes('dsht-loop')));
  idle(fixture);
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 2);
  assert.match(lastPrompt(fixture), /现在是第 2 轮、第 1\/2 次尝试/);
  assert.equal(controller.queries.loop?.step, 2);

  // A low score costs one attempt, and exhausting the budget stops the run.
  reply(fixture, 11, 'still weak\n' + block(2, 1, 7));
  await until(() => controller.queries.record.messages.length > 2);
  idle(fixture);
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 3);
  assert.match(lastPrompt(fixture), /现在是第 2 轮、第 2\/2 次尝试/);

  reply(fixture, 12, 'no block at all');
  await until(() => controller.queries.record.messages.length > 3);
  idle(fixture);
  // The fixture keeps the earlier block visible, so the score repeats at the last attempt, which
  // spends the remaining budget (a single plateau is tolerated rather than called a stall).
  await until(() => controller.queries.loop?.phase === 'exhausted');
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 3);
  assert.equal(controller.queries.loop?.best, 7);
});

test('typed text, an explicit stop and a session switch all end the loop', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(designReviewProtocol(), { from: 1, to: 10, score: 8, tries: 10 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  assert.equal(controller.queries.loop?.phase, 'running');
  // A human turn takes the conversation back, so the loop stops instead of racing it.
  await controller.actions.prompt('never mind');
  assert.equal(controller.queries.loop?.phase, 'cancelled');

  await controller.actions.startLoop(designReviewProtocol(), { from: 1, to: 10, score: 8, tries: 10 });
  assert.equal(controller.queries.loop?.phase, 'running');
  controller.actions.stopLoop();
  assert.equal(controller.queries.loop?.phase, 'cancelled');

  // A loop belongs to its session, so opening another one drops it entirely.
  await controller.actions.startLoop(designReviewProtocol(), { from: 1, to: 10, score: 8, tries: 10 });
  assert.equal(controller.queries.loop?.step, 1);
  await controller.actions.selectSession('s2');
  await until(() => controller.state.sessionId === 's2');
  assert.equal(controller.queries.loop, undefined);
});

test('loop prompts stay out of composer recall while typed prompts remain', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  // The opened snapshot already contributes one prompt (the fixture's `你好`).
  const before = controller.queries.recallLength;
  await controller.actions.startLoop(designReviewProtocol(), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  // The host echoes a prompt back as a durable user message; a loop prompt must not become recall.
  const brief = lastPrompt(fixture);
  fixture.follow({ type: 'event', event: { seq: 20, type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text: brief }] } } });
  await until(() => controller.queries.record.messages.some(message => message.text.includes('只执行第 1 轮')));
  assert.equal(controller.queries.recallLength, before);
  assert.equal(controller.queries.recall(-1, 'draft'), '你好');
  // Leave recall navigation, the way editing the composer would, before the next assertion.
  controller.actions.resetRecall();

  // A prompt the operator typed is still recalled, so the filter is not a blanket one.
  await controller.actions.prompt('remember me');
  fixture.follow({ type: 'event', event: { seq: 21, type: 'user/message', surfaceOp: 'append',
    data: { content: [{ type: 'text', text: 'remember me' }] } } });
  await until(() => controller.queries.recallLength === before + 1);
  assert.equal(controller.queries.recall(-1, 'draft'), 'remember me');
});

test('a blocked verdict stops the loop without spending the remaining budget', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(designReviewProtocol(), { from: 1, to: 10, score: 8, tries: 10 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const before = fixture.calls.filter(call => call.method === 'session/prompt').length;
  // The verifier proved the task impossible; the run ends here rather than trying nine more times.
  reply(fixture, 30, 'cannot be done\n```dsht-loop\n{"kind":"design-review","step":1,"attempt":1,"status":"blocked"}\n```');
  await until(() => controller.queries.record.messages.some(message => message.text.includes('cannot be done')));
  idle(fixture);
  await until(() => controller.queries.loop?.phase === 'blocked');
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, before);
});

test('a result block committed just after the idle event is still read', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(designReviewProtocol(), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  // The host reports the turn idle a moment before the final message reaches the follow stream, so
  // the first parse finds no block. That is not a failed attempt: the loop keeps looking for it.
  // The idle event arrives on its own stream, so wait for the counter only that event increments:
  // otherwise the reply can be processed first and the regression this test guards is not exercised.
  const finished = controller.queries.turnsCompleted;
  idle(fixture);
  await until(() => controller.queries.turnsCompleted > finished);
  // Deciding the attempt here is what the old code did; the block may still be on its way.
  assert.equal(controller.queries.loop?.attempt, 1);
  assert.equal(controller.queries.loop?.best, 0);
  assert.equal(controller.queries.loop?.phase, 'running');

  // The late reply carries a passing score, so the loop advances instead of spending a second try.
  // Advancing is the whole guard: the old code had already spent the attempt and would sit at step 1.
  reply(fixture, 40, 'findings…\n' + block(1, 1, 9));
  await until(() => controller.queries.loop?.step === 2, 15_000);
});

test('a control frame this client cannot decode never strands a running loop', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(designReviewProtocol(), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));

  // A jobs frame with no rows once failed the whole generation, which left the loop settling
  // against a transcript that could never refill; live metrics now degrade instead.
  fixture.control({ type: 'jobs', sessionId: 's1' });
  await until(() => controller.state.controlError !== undefined);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(controller.state.online, true);
  assert.equal(controller.queries.loop?.phase, 'running');

  reply(fixture, 50, 'findings…\n' + block(1, 1, 9));
  idle(fixture);
  await until(() => controller.queries.loop?.step === 2);
});

test('a reconnect re-attaches the loop when the picker replaced the selection', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  // Registering the client's own directory as a workspace is what makes a reconnect fall back to
  // the picker and drop the session, so the loop has to find its session again by itself.
  fixture.baseline = [{ ...workspace, path: process.cwd() }];
  // No `initialSession`, so nothing but the loop can put the session back after the drop.
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  // `ready()` adopts the local workspace and drops the selection on its way in, so pick only after
  // it has settled on the session list.
  await until(() => controller.state.online && controller.state.workspaceId === 'w1' && controller.state.screen === 'sessions', 15_000);
  await controller.actions.selectSession('s1');
  await until(() => controller.state.sessionId === 's1' && controller.queries.record.ready, 15_000);

  await controller.actions.startLoop(designReviewProtocol(), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));

  fixture.disconnect();
  await until(() => !controller.state.online);
  await until(() => controller.state.online && controller.state.sessionId === 's1' && controller.queries.record.ready, 15_000);
  assert.equal(controller.queries.loop?.phase, 'running');

  // The re-attached transcript still settles the attempt that was outstanding across the drop.
  reply(fixture, 60, 'findings…\n' + block(1, 1, 9));
  idle(fixture);
  await until(() => controller.queries.loop?.step === 2, 15_000);
});

test('a reconnect keeps the loop while a switch to another session ends it', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(designReviewProtocol(), { from: 1, to: 10, score: 8, tries: 10 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  assert.equal(controller.queries.loop?.phase, 'running');

  // A dropped generation is not a session switch: the host keeps reviewing, so the loop waits.
  fixture.disconnect();
  await until(() => !controller.state.online);
  assert.equal(controller.queries.loop?.phase, 'running');
  await until(() => controller.state.online && controller.state.sessionId === 's1' && controller.queries.record.ready, 15_000);
  assert.equal(controller.queries.loop?.phase, 'running');

  // Selecting another session is the real boundary.
  await controller.actions.selectSession('s2');
  await until(() => controller.state.sessionId === 's2');
  assert.equal(controller.queries.loop, undefined);
});
