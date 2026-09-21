/** A scored round judged by an independent verifier process instead of the reviewer's own reply. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, loopProtocolFor } from '../../src/controller/index.ts';
import type { LoopProtocol } from '../../src/controller/loop.ts';
import { runStartup } from '../../src/cli/startup.ts';
import { runCommand } from '../../src/controller/commands.ts';
import { parseCommand } from '../../src/slash/index.ts';
import { readTrace } from '../../src/controller/trace-log.ts';
import type { VerifierOutcome, VerifierRequest } from '../../src/controller/verifier.ts';
import { array, object } from '../../src/transport/wire.ts';
import { host, until } from '../support/host.ts';

/** The shipped record, pinned to work-first so one test can drive one attempt at a time.
 *
 * The record itself verifies before it asks for work (see the verify-first tests below); these tests
 * are about what happens to a verdict, so they keep the prompt-then-verify shape they were written
 * for by overriding that one field.
 * @param name - Record to build.
 * @param forked - Whether the record delegates to a verifier.
 * @returns The record with `starts: 'work'`.
 */
function workFirst(name: string, forked = true): LoopProtocol {
  // These tests are about what one verdict does to the run. The artifact contract has its own tests
  // below, and the repository's own review files are never part of a test's fixture.
  return { ...loopProtocolFor(name, forked)!, starts: 'work', artifactMarker: undefined };
}

/** Scratch reviewed workspace holding one artifact, so the artifact check reads a known file.
 * @param artifact - File name the record writes.
 * @param contents - What that file already contains.
 * @returns The directory and its cleanup.
 */
async function reviewedWorkspace(artifact: string, contents: string): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-loop-'));
  await writeFile(join(directory, artifact), contents);
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** Text of the newest `session/prompt` request. */
function lastPrompt(fixture: Awaited<ReturnType<typeof host>>): string {
  const call = fixture.calls.filter(entry => entry.method === 'session/prompt').at(-1)!;
  return String(object(array(object(object(object(call.payload).args).request).content)[0]).text);
}

/** Report the reviewed session idle, which is what ends an attempt. */
function idle(fixture: Awaited<ReturnType<typeof host>>, sessionId: string): void {
  fixture.emit({ type: 'emit', event: 'api-session/status', args: [sessionId, false] });
}

/** A verifier whose verdict, note and cancellation the test controls. */
function fakeVerifier(outcome: (request: VerifierRequest) => VerifierOutcome | Promise<VerifierOutcome>) {
  const requests: VerifierRequest[] = [];
  const signals: AbortSignal[] = [];
  return {
    requests, signals,
    port: {
      verify: async (request: VerifierRequest, signal: AbortSignal): Promise<VerifierOutcome> => {
        requests.push(request); signals.push(signal);
        return await outcome(request);
      },
    },
  };
}

test('a forked verdict decides the round, and the reviewer is told not to self-score', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'verified', result: { score: 9, status: 'done' }, sessionId: 'session-verifier' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  // The brief asks for the work, not for a grader: the verdict comes from another process.
  assert.match(lastPrompt(fixture), /独立验证进程/);
  assert.doesNotMatch(lastPrompt(fixture), /spawn 一个全新的 verifier 子代理/);

  idle(fixture, 's1');
  await until(() => controller.queries.loop?.step === 2);
  const request = verifier.requests[0]!;
  assert.equal(request.kind, 'designdoc-review');
  assert.equal(request.step, 1);
  assert.equal(request.attempt, 1);
  // The path is namespaced by the run and by this verification task, so two clients — or a retry —
  // can never read each other's verdict.
  assert.match(request.file, /\.dsht\/verify\/[0-9a-f-]{36}\/designdoc-review-1-1-1\.json$/);
  assert.match(request.verificationId, /^[0-9a-f-]{36}\/designdoc-review\/1\/1\/1$/);
  assert.ok(request.file.includes(request.verificationId.split('/')[0]!));
  assert.match(request.title, /^\[dsht-verify\]/);
  // The request declares which workspace the round is about, so the artifact check cannot infer it.
  assert.equal(request.workspace, controller.localDirectory);
  // The verifier's own prompt carries the file it must write and the rubric for this step.
  assert.match(request.prompt, /定位与范围/);
  // The prompt never names the file: the child owns persistence and reads the reply instead.
  assert.doesNotMatch(request.prompt, /把结论写入/);
  assert.match(request.prompt, /回复正文的最后输出唯一一个 JSON 对象/);
  assert.equal(controller.queries.loop?.best, 0, 'a new step starts its own best');
});

test('an abstained verdict pauses the run, and an answer re-judges it without spending an attempt', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  // The first judgment abstains and every one after it passes, so the answer is what changed the run.
  let judged = 0;
  const verifier = fakeVerifier(() => (judged++ === 0
    ? { type: 'verified', result: { status: 'abstained', abstained: true, exitReason: 'needs-human',
        reason: '哪一侧是权威？', needs: '先定权威' }, sessionId: 'session-verifier' }
    : { type: 'verified', result: { score: 9, status: 'done' }, sessionId: 'session-verifier' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');

  // The verifier abstained: the run is paused, not finished. It still owns the session, says what it
  // needs, and no attempt was consumed by the judgment or by waiting.
  await until(() => controller.queries.loop?.phase === 'needs-human');
  const paused = controller.queries.loop!;
  assert.equal(paused.active, true);
  assert.equal(paused.terminalReason, undefined);
  assert.equal(paused.step, 1);
  assert.equal(paused.attempt, 1);
  assert.deepEqual(paused.interaction, { kind: 'verdict', text: '哪一侧是权威？', needs: '先定权威' });
  assert.equal(verifier.requests.length, 1);

  // The operator answers: the same artifact is judged again, under a new task identity, with the
  // answer in the prompt. Nothing is sent to the agent for it.
  const promptsBefore = fixture.calls.filter(call => call.method === 'session/prompt').length;
  void controller.actions.answerLoop('以 tui-design.md 为准');
  await until(() => verifier.requests.length === 2);
  const answered = verifier.requests[1]!;
  assert.equal(answered.verificationId, verifier.requests[0]!.verificationId.replace(/\/1$/, '/2'), 'a new task identity');
  assert.match(answered.prompt, /操作者的补充判断/);
  assert.match(answered.prompt, /以 tui-design\.md 为准/);
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, promptsBefore, 'an answer is not a work order');
  // The second verdict decides the attempt normally, and the answer consumed none of the budget.
  await until(() => controller.queries.loop?.step === 2);
  assert.equal(controller.queries.loop?.attempt, 1);
  assert.equal(controller.queries.loop?.interaction, undefined);
});

test('/loop abort ends a paused run, which is the only way out when nobody answers', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'verified',
    result: { status: 'abstained', abstained: true, exitReason: 'needs-human', reason: '需要人' }, sessionId: 'session-verifier' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);
  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');
  await until(() => controller.queries.loop?.phase === 'needs-human');
  // `/loop stop` and `/loop abort` are the same action; the paused spelling is the natural one here.
  const port = { run: async () => undefined };
  await runCommand(controller, parseCommand('/loop abort'), port);
  assert.equal(controller.queries.loop?.phase, 'cancelled');
  assert.equal(controller.queries.loop?.terminalReason, 'user-cancelled');
  assert.equal(controller.queries.loop?.active, false);
});

test('a verifier outage is retried and never lets the reply block pass', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'unavailable', reason: 'verifier wrote no verdict (exit 1)' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const body = JSON.stringify({ kind: 'designdoc-review', step: 1, attempt: 1, score: 8.5, status: 'done' });
  fixture.follow({ type: 'event', event: { seq: 50, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: `findings\n\`\`\`dsht-loop\n${body}\n\`\`\`` }] } } } });
  await until(() => controller.queries.record.messages.some(message => message.text.includes('dsht-loop')));

  idle(fixture, 's1');
  // Strict by default: an outage is retried, consumes no attempt, and no reply block can pass it.
  await until(() => controller.queries.loop?.phase === 'unavailable', 15_000);
  assert.equal(verifier.requests.length, 3);
  assert.equal(controller.queries.loop?.step, 1);
  assert.equal(controller.queries.loop?.attempt, 1);
  assert.match(controller.queries.loop?.note ?? '', /verification unavailable/);
});

test('a failure that says it is not retryable is reported instead of retried', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'unavailable', reason: 'verifier timed out after 20 ms · remote cancel unconfirmed after 1000 ms',
    sessionId: 'session-verifier', retryable: false }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');
  await until(() => controller.queries.loop?.phase === 'unavailable');

  // Retrying could overlap a remote turn that never confirmed its cancel, so one attempt is all.
  assert.equal(verifier.requests.length, 1);
  assert.equal(controller.queries.loop?.attempt, 1);
  assert.match(controller.queries.loop?.note ?? '', /unconfirmed/);
});

test('the whole-run deadline stops a slow verification and its late verdict', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  let release: (() => void) | undefined;
  const verifier = fakeVerifier(async () => {
    // Slow enough that the deadline fires first; the promise still settles afterwards.
    await new Promise<void>(resolve => { release = resolve; });
    return { type: 'verified', result: { score: 10, status: 'done' }, sessionId: 'session-verifier' };
  });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1',
    verifier: verifier.port, deadlineMs: 40 });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 2, score: 8, tries: 3 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');
  await until(() => controller.queries.loop?.phase === 'deadline');

  // The in-flight verification was cancelled, and no retry was started.
  assert.equal(verifier.requests.length, 1);
  assert.equal(verifier.signals[0]?.aborted, true);
  assert.equal(controller.queries.loop?.attempt, 1);
  assert.match(controller.queries.loop?.note ?? '', /deadline/);
  // A verdict that arrives after the budget expired cannot revive the run.
  release?.();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(controller.queries.loop?.phase, 'deadline');
  assert.equal(controller.queries.loop?.best, 0);
});

test('a verifier blocked on a host request stops the loop without retrying', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'needs-human', request: { kind: 'question', text: 'Which branch?' }, sessionId: 'session-verifier' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');
  await until(() => controller.queries.loop?.phase === 'needs-human');

  // The verifier is blocked, not broken: one verification, no retry storm, no attempt spent.
  assert.equal(verifier.requests.length, 1);
  assert.equal(controller.queries.loop?.attempt, 1);
  assert.equal(controller.queries.loop?.best, 0);
  assert.deepEqual(controller.queries.loop?.interaction, { kind: 'question', text: 'Which branch?' });
});

test('a verdict that proves the task impossible ends the run and keeps its reason', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'verified', sessionId: 'session-verifier',
    result: { status: 'blocked', blocked: true, exitReason: 'cannot-fix', reason: '没有取消端点，远端 turn 无法保证停下' } }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 10, score: 8, tries: 10 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const prompts = fixture.calls.filter(call => call.method === 'session/prompt').length;
  idle(fixture, 's1');
  await until(() => controller.queries.loop?.phase === 'blocked');

  // An impossible task is a fact, not a low score: the run stops instead of spending nine more
  // rounds, and the reason is what the operator reads.
  assert.deepEqual(controller.queries.loop?.exit, { reason: '没有取消端点，远端 turn 无法保证停下' });
  assert.equal(controller.queries.loop?.step, 1);
  assert.equal(controller.queries.loop?.attempt, 1);
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, prompts);
  assert.equal(verifier.requests.length, 1);
});

test('a verdict that abstains asks for a person and pauses the run', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'verified', sessionId: 'session-verifier',
    result: { status: 'abstained', abstained: true, exitReason: 'needs-human', reason: '需要人决定改哪一侧',
      needs: '改哪一侧？' } }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');
  await until(() => controller.queries.loop?.phase === 'needs-human');

  // The request pauses the run instead of being retried as an outage: it keeps its span, its budget
  // and its session, and only the operator ends or continues it.
  assert.deepEqual(controller.queries.loop?.interaction,
    { kind: 'verdict', text: '需要人决定改哪一侧', needs: '改哪一侧？' });
  assert.equal(controller.queries.loop?.active, true);
  assert.equal(controller.queries.loop?.terminalReason, undefined);
  assert.equal(controller.queries.loop?.attempt, 1);
  assert.equal(controller.queries.loop?.best, 0);
  assert.equal(verifier.requests.length, 1, 'and no retry is started while it waits');
});

test('a headless run stopped by a host request reports needs-human', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'needs-human', request: { kind: 'approval', text: 'Confirm the build' }, sessionId: 'session-verifier' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();

  const lines: string[] = [];
  const running = runStartup(controller, { workspace: 'w1', session: 'new',
    commands: ['/loop designdoc-review --to 1 --tries 2'], timeoutSeconds: 15 }, line => lines.push(line));
  // The shipping record verifies first, so the request arrives without any work turn: the verifier
  // is asked about the artifact as it stands, and a blocked verifier is reported, not retried.
  assert.equal(await running, 'needs-human');
  assert.ok(lines.some(line => line.includes('needs-human') && line.includes('Confirm the build')));
  assert.equal(controller.queries.loop?.attempt, 1);
  assert.equal(verifier.requests.length, 1);
});

test('a whole-record run reports its scope, and one round never claims the whole record', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'verified', result: { score: 9, status: 'done' }, sessionId: 'session-verifier' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  // The shipping record verifies the existing artifact first, so round 1 is judged before any work.
  await controller.actions.startLoop(loopProtocolFor('designdoc-review', true)!, { from: 1, to: 10, score: 8, tries: 2 });
  await until(() => verifier.requests.length > 0);
  // The snapshot says which rounds the run covers, so a pass can never be read as more than that.
  assert.equal(controller.queries.loop?.scope, 'rounds 1–10/10');
  // Round 1 is not the consolidation round: it never carries the whole-record re-check.
  assert.doesNotMatch(verifier.requests[0]!.prompt, /覆盖全部/);
});

test('a verification retry is a new task with its own identity and file', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  let calls = 0;
  const verifier = fakeVerifier(() => {
    calls += 1;
    return calls === 1
      ? { type: 'unavailable', reason: 'verifier wrote no verdict (exit 1)' }
      : { type: 'verified', result: { score: 9, status: 'done' }, sessionId: 'session-verifier' };
  });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 1, score: 8, tries: 1 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');
  await until(() => controller.queries.loop?.phase === 'passed', 15_000);
  assert.equal(verifier.requests.length, 2);
  const [first, second] = verifier.requests as [VerifierRequest, VerifierRequest];
  // Same round and attempt, different verification task: the retry can never be scored by the
  // task it replaced, and its file cannot overwrite that task's.
  assert.equal(first.step, second.step);
  assert.equal(first.attempt, second.attempt);
  assert.notEqual(first.verificationId, second.verificationId);
  assert.notEqual(first.file, second.file);
  assert.match(second.verificationId, /\/1\/1\/2$/);
});

test('a forked round with neither verdict nor block ends as verification unavailable', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'unavailable', reason: 'verifier wrote no verdict (signal SIGKILL)' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 1, score: 8, tries: 1 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');
  // No verdict and no block is an outage, not a failing review: the attempt is not consumed.
  await until(() => controller.queries.loop?.phase === 'unavailable', 15_000);
  assert.equal(controller.queries.loop?.best, 0);
  assert.equal(controller.queries.loop?.attempt, 1);
  assert.match(controller.queries.loop?.note ?? '', /SIGKILL/);
});

test('cancelling the review cancels the verifier and ignores its late verdict', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  let settle: ((outcome: VerifierOutcome) => void) | undefined;
  const signals: AbortSignal[] = [];
  const port = { verify: (request: VerifierRequest, signal: AbortSignal): Promise<VerifierOutcome> => {
    void request;
    signals.push(signal);
    return new Promise<VerifierOutcome>(resolve => { settle = resolve; });
  } };
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');
  await until(() => settle !== undefined);
  const before = fixture.calls.filter(call => call.method === 'session/prompt').length;

  controller.actions.stopLoop();
  assert.equal(controller.queries.loop?.phase, 'cancelled');
  // Stopping the run has to reach the verifier itself, or its child would keep the host busy.
  assert.equal(signals[0]?.aborted, true);
  // A verdict that arrives after cancellation must not revive or advance the run.
  settle!({ type: 'verified', result: { score: 10, status: 'done' }, sessionId: 'session-v' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(controller.queries.loop?.phase, 'cancelled');
  assert.equal(controller.queries.loop?.step, 1);
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, before);
});

test('a host without a verifier keeps scoring from the reply block', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);
  assert.equal(controller.queries.forkedVerification, false);
  // The same command asks for a grader instead, because no verifier is available.
  await controller.actions.startLoop(workFirst('designdoc-review', controller.queries.forkedVerification), { from: 1, to: 1, score: 8, tries: 1 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  assert.match(lastPrompt(fixture), /spawn 一个全新的 verifier 子代理/);
});

test('the retry carries the verifier findings, and a second plateau stops the run', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const findings = ['缺「域→章节」映射', '行数计数过期'];
  const verifier = fakeVerifier(() => ({ type: 'verified', result: { score: 5, status: 'retry', evidence: 'independent recheck', findings },
    sessionId: 'session-v' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 1, score: 8, tries: 5 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');

  // The retry quotes the verifier's own findings instead of only saying the score was too low.
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 2, 15_000);
  const retry = lastPrompt(fixture);
  assert.match(retry, /缺「域→章节」映射/);
  assert.match(retry, /行数计数过期/);
  assert.match(retry, /逐条处理/);

  // The next verifier is told what it objected to, so its score measures convergence.
  idle(fixture, 's1');
  await until(() => verifier.requests.length === 2, 15_000);
  assert.match(verifier.requests[1]!.prompt, /上一次（第 1 轮第 1 次）/);
  assert.match(verifier.requests[1]!.prompt, /缺「域→章节」映射/);

  // One plateau may be jitter, so a third attempt is allowed; the second plateau stops the run
  // rather than spending the rest of the budget on the same conclusion.
  await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 3, 15_000);
  idle(fixture, 's1');
  await until(() => controller.queries.loop?.phase === 'stalled', 15_000);
  assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 3);
  // A verdict of its own needs no note: the progress line only explains a missing one.
  assert.equal(controller.queries.loop?.note, undefined);
});

test('the client can stop a verifier session on the host without selecting it', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  // A verifier session is created in the reviewed workspace, which the run selects first.
  await runStartup(controller, { workspace: 'w1', session: 'new', commands: [], timeoutSeconds: 10 }, () => {});
  const verifierSession = await controller.actions.createVerifierSession('[dsht-verify] stop me');
  assert.ok(verifierSession);
  fixture.calls.length = 0;
  assert.equal(await controller.actions.cancelVerifierSession(verifierSession!), true);
  // The host is what actually stops the agent, so the cancel has to arrive as a session/cancel call.
  const cancel = fixture.calls.find(call => call.method === 'session/cancel');
  assert.ok(cancel, 'expected a session/cancel call');
  assert.equal(String(object(object(object(cancel!.payload).args).request).sessionId), verifierSession);
});

test('self-scoring is opt-in and always visible', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'unavailable', reason: 'verifier wrote no verdict (exit 1)' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1',
    verifier: verifier.port, allowSelfFallback: true });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const body = JSON.stringify({ kind: 'designdoc-review', step: 1, attempt: 1, score: 8.5, status: 'done' });
  fixture.follow({ type: 'event', event: { seq: 70, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: `findings\n\`\`\`dsht-loop\n${body}\n\`\`\`` }] } } } });
  await until(() => controller.queries.record.messages.some(message => message.text.includes('dsht-loop')));

  idle(fixture, 's1');
  await until(() => controller.queries.loop?.step === 2, 15_000);
  // The fallback decided the round, and the progress line says so on the step that follows.
  assert.equal(controller.queries.loop?.note, '⚠ verification fallback · self-reported');
});

test('a verify-first record verifies each round before asking for any work', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'verified', result: { score: 9, status: 'done' }, sessionId: 'session-verifier' }));
  // The reviewed document already carries both rounds' sections, which is what verify-first is for.
  const workspace = await reviewedWorkspace('DESIGN-DOC-REVIEW.md',
    '## 第 1 轮 · 定位与范围\nround one\n\n## 第 2 轮 · 结构与导航\nround two\n');
  t.after(() => workspace.cleanup());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1',
    localDirectory: workspace.directory, verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(loopProtocolFor('designdoc-review', true)!, { from: 1, to: 2, score: 8, tries: 2 });
  await until(() => controller.queries.loop?.phase === 'passed');
  // Both rounds were judged against the artifact as it stands: nobody was asked to work at all.
  assert.deepEqual(verifier.requests.map(request => request.step), [1, 2]);
  assert.equal(fixture.calls.some(call => call.method === 'session/prompt'), false);
});

test('a verify-first round that fails asks for work, carrying the findings', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  let calls = 0;
  const verifier = fakeVerifier(() => {
    calls += 1;
    return calls === 1
      ? { type: 'verified', result: { score: 4, status: 'retry', findings: ['缺少取消接口'] }, sessionId: 'session-verifier' }
      : { type: 'verified', result: { score: 9, status: 'done' }, sessionId: 'session-verifier' };
  });
  const workspace = await reviewedWorkspace('DESIGN-DOC-REVIEW.md', '## 第 1 轮 · 定位与范围\nround one\n');
  t.after(() => workspace.cleanup());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1',
    localDirectory: workspace.directory, verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(loopProtocolFor('designdoc-review', true)!, { from: 1, to: 1, score: 8, tries: 2 });
  // Only the failed verdict produces a work turn, and it carries the verifier's own findings.
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  assert.equal(verifier.requests.length, 1);
  assert.match(lastPrompt(fixture), /缺少取消接口/);
  idle(fixture, 's1');
  await until(() => controller.queries.loop?.phase === 'passed');
  assert.equal(verifier.requests.length, 2);
});

test('a high score cannot pass a round whose output never reached the artifact', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'verified', result: {
    score: 9.5, status: 'done', evidence: '全文复核通过' }, sessionId: 'session-verifier' }));
  // The document exists but has no section for this round: the round's conclusion was not written.
  const workspace = await reviewedWorkspace('DESIGN-DOC-REVIEW.md', '## 第 1 轮 · 定位与范围\nround one\n');
  t.after(() => workspace.cleanup());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1',
    localDirectory: workspace.directory, verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  // Round 2 is judged first (verify-first) and scores 9.5, but the artifact has no round-2 section.
  await controller.actions.startLoop(loopProtocolFor('designdoc-review', true)!, { from: 2, to: 2, score: 8, tries: 2 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));

  // The verifier's own finding stays in the feedback; the missing section is added as a hard one.
  assert.match(lastPrompt(fixture), /工作区文件 DESIGN-DOC-REVIEW\.md 缺少本轮小节「## 第 2 轮 · 结构与导航」/);
  assert.match(controller.queries.loop?.note ?? '', /artifact check/);
  assert.equal(controller.queries.loop?.phase, 'running');
  assert.equal(controller.queries.loop?.best, 0, 'a score that cannot pass must not raise best');
  assert.equal(controller.queries.loop?.attempt, 2, 'the round costs one attempt, like any failure');
});

test('the artifact check leaves a round alone when the section is there or unreadable', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'verified', result: { score: 9, status: 'done' }, sessionId: 'session-verifier' }));
  const workspace = await reviewedWorkspace('DESIGN-DOC-REVIEW.md', '## 第 1 轮 · 定位与范围\nround one\n');
  t.after(() => workspace.cleanup());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1',
    localDirectory: workspace.directory, verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(loopProtocolFor('designdoc-review', true)!, { from: 1, to: 1, score: 8, tries: 2 });
  await until(() => controller.queries.loop?.phase === 'passed');
  assert.doesNotMatch(controller.queries.loop?.note ?? '', /artifact check/);

  // A workspace this client cannot read cannot be checked, so the verdict stands rather than being
  // failed on a boundary the client cannot see.
  const elsewhere = await host(); t.after(() => elsewhere.close());
  const blind = fakeVerifier(() => ({ type: 'verified', result: { score: 9, status: 'done' }, sessionId: 'session-verifier' }));
  const remote = new Controller({ base: elsewhere.url, token: 'fixture-token', initialSession: 's1',
    localDirectory: join(tmpdir(), 'dsht-not-here-0000'), verifier: blind.port });
  t.after(async () => { await remote.stop(); });
  remote.start();
  await until(() => remote.state.online && remote.queries.record.ready);
  await remote.actions.startLoop(loopProtocolFor('designdoc-review', true)!, { from: 1, to: 1, score: 8, tries: 2 });
  await until(() => remote.queries.loop?.phase === 'passed');
  assert.doesNotMatch(remote.queries.loop?.note ?? '', /artifact check/);
});

test('a forked round traces its verifier lifecycle, so a missing verdict has a written reason', async t => {
  const fixture = await host();
  const directory = await mkdtemp(join(tmpdir(), 'dsht-verify-trace-'));
  const tracePath = join(directory, 'trace.log');
  // The first verification is held open, so the "working" note can be observed before it resolves.
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const verifier = fakeVerifier(async () => {
    await gate;
    return { type: 'unavailable', reason: 'verifier wrote no verdict (exit 1) · stderr: boom' };
  });
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1',
    verifier: verifier.port, tracePath });
  // One hook in the right order: the trace is drained before the directory holding it goes away.
  t.after(async () => {
    await controller.stop();
    fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(workFirst('designdoc-review'), { from: 1, to: 1, score: 8, tries: 1 });
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  idle(fixture, 's1');
  // The sub-state is controller data, so the run says it is verifying without any note text.
  await until(() => controller.queries.loop?.activity === 'verify');
  // The merged answer the status bar reads: a loop, its sub-state, and the clock it carries itself.
  const busy = controller.queries.activity;
  assert.equal(busy?.kind, 'loop');
  assert.equal(busy?.kind === 'loop' ? busy.activity : undefined, 'verify');
  assert.equal(busy?.kind === 'loop' ? busy.step : undefined, 1);
  assert.equal(busy?.kind === 'loop' ? busy.total : undefined, 10);
  assert.ok((busy?.kind === 'loop' ? busy.startedAt : 0) > 0);
  release!();
  await until(() => controller.queries.loop?.phase === 'unavailable');
  await controller.trace?.settle();

  const events = (await readTrace(tracePath)).filter(line => !line.startsWith('#'))
    .map(line => JSON.parse(line) as { event: string; phase?: string; reason?: string });
  const verified = events.filter(entry => entry.event === 'verify');
  // One begin per attempt, a retry between them, and a final reason the operator can act on.
  assert.deepEqual(verified.map(entry => entry.phase), ['begin', 'retry', 'begin', 'retry', 'begin', 'unavailable']);
  assert.match(verified.at(-1)?.reason ?? '', /boom/);
});
