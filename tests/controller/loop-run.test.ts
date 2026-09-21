/** The client-driven loop, driven end to end against the host fixture through one protocol. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, loopProtocolFor } from '../../src/controller/index.ts';
import { array, object, type ObjectValue } from '../../src/transport/wire.ts';
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

/** The shipped record without the artifact contract.
 *
 * These tests drive the loop through its verdicts; whether a round's section reached the file is
 * checked by its own tests, and no test may depend on a review file that happens to be in the repo.
 * @param name - Record to build.
 * @returns The record with no `artifactMarker`.
 */
const protocol = (name: string) => ({ ...loopProtocolFor(name)!, artifactMarker: undefined });

test('the loop sends the brief, advances on a passing score and stops on a failing step', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  assert.equal(await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 2, score: 8, tries: 2 }), true);
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  // The opening send is the scoped brief, not a follow-up.
  assert.match(lastPrompt(fixture), /只执行第 1 轮的第 1 次尝试/);
  // The start time is a wall clock and the identity is generated per run, so the snapshot compares
  // without them and only checks they are set.
  const { startedAt, runId, ...progress } = controller.queries.loop!;
  assert.ok(startedAt > 0);
  assert.ok(runId.length > 0);
  assert.deepEqual(progress, {
    title: 'Design review', from: 1, to: 2, score: 8, tries: 2, total: 10, scope: 'rounds 1–2/10 · selected range',
    step: 1, attempt: 1, best: 0, phase: 'running', active: true, activity: 'turn', stepLabel: '职责与归属' });

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

test('a loop prompt waits for the foreground slot instead of failing the run', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  assert.equal(await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 2, score: 8, tries: 2 }), true);
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 1);
  // A foreground operation owns the execution slot while the round's verdict is consumed.
  let finish!: (value: ObjectValue) => void;
  fixture.onCommand = () => new Promise(resolve => { finish = resolve; });
  const compact = controller.actions.command('/compact', new AbortController().signal);
  await until(() => controller.queries.foreground !== undefined);
  reply(fixture, 10, 'findings…\n' + block(1, 1, 8.5));
  await until(() => controller.queries.record.messages.some(message => message.text.includes('dsht-loop')));
  idle(fixture);
  // The next round is prepared but the slot is taken: the prompt is held, not dropped, and the run
  // stays alive instead of ending as a rejected send.
  await until(() => controller.queries.loop?.step === 2);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 1);
  assert.equal(controller.queries.loop?.active, true);
  assert.equal(controller.queries.loop?.phase, 'running');
  // Freeing the slot sends the held prompt, with the advanced round.
  finish({ commandId: 'c1', result: { kind: 'success', text: 'Compacted.' } });
  await compact;
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 2);
  assert.match(lastPrompt(fixture), /现在是第 2 轮、第 1\/2 次尝试/);
});

test('typed text, an explicit stop and a session switch all end the loop', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 10, score: 8, tries: 10 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  assert.equal(controller.queries.loop?.phase, 'running');
  // A human turn takes the conversation back, so the loop stops instead of racing it.
  await controller.actions.prompt('never mind');
  assert.equal(controller.queries.loop?.phase, 'cancelled');

  await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 10, score: 8, tries: 10 });
  assert.equal(controller.queries.loop?.phase, 'running');
  controller.actions.stopLoop();
  assert.equal(controller.queries.loop?.phase, 'cancelled');

  // A loop belongs to its session, so opening another one drops it entirely.
  await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 10, score: 8, tries: 10 });
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
  await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 2, score: 8, tries: 2 });
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

  await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 10, score: 8, tries: 10 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const before = fixture.calls.filter(call => call.method === 'session/prompt').length;
  // The verifier proved the task impossible; the run ends here rather than trying nine more times.
  reply(fixture, 30, 'cannot be done\n```dsht-loop\n{"kind":"design-review","step":1,"attempt":1,"status":"blocked","reason":"做不到"}\n```');
  await until(() => controller.queries.record.messages.some(message => message.text.includes('cannot be done')));
  idle(fixture);
  await until(() => controller.queries.loop?.phase === 'blocked');
  assert.deepEqual(controller.queries.loop?.exit, { reason: '做不到' });
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, before);
});

test('a result block committed just after the idle event is still read', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 2, score: 8, tries: 2 });
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

  await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 2, score: 8, tries: 2 });
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

  await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 2, score: 8, tries: 2 });
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

  await controller.actions.startLoop(protocol('design-review'), { from: 1, to: 10, score: 8, tries: 10 });
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

test('a passing reply block cannot pass a round whose section is missing from the artifact', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  // The reviewed file exists but never got this round's section: the round's conclusion is not there.
  const directory = await mkdtemp(join(tmpdir(), 'dsht-loop-run-'));
  await writeFile(join(directory, 'DESIGN-REVIEW.md'), '# 设计审查\n');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1',
    localDirectory: directory });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(loopProtocolFor('design-review')!, { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  reply(fixture, 20, 'looks great\n' + block(1, 1, 9));
  await until(() => controller.queries.record.messages.some(message => message.text.includes('dsht-loop')));
  idle(fixture);
  // The score would pass, but the artifact requirement is a fact the client checks itself.
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 2);
  assert.equal(controller.queries.loop?.step, 1, 'the round did not advance');
  assert.equal(controller.queries.loop?.attempt, 2, 'the round cost one attempt');
  assert.match(controller.queries.loop?.note ?? '', /artifact check/);
  assert.match(lastPrompt(fixture), /工作区文件 DESIGN-REVIEW\.md 缺少本轮小节「## 第 1 轮 · 职责与归属」/);
});

test('a no-verifier workspace this client cannot read keeps its reply score', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1',
    localDirectory: join(tmpdir(), 'dsht-loop-not-here-0000') });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(loopProtocolFor('design-review')!, { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  reply(fixture, 21, 'looks great\n' + block(1, 1, 9));
  await until(() => controller.queries.record.messages.some(message => message.text.includes('dsht-loop')));
  idle(fixture);
  await until(() => controller.queries.loop?.step === 2);
  assert.doesNotMatch(controller.queries.loop?.note ?? '', /artifact check/);
});
