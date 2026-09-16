/** A scored round judged by an independent verifier process instead of the reviewer's own reply. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller, designdocReviewProtocol } from '../../src/controller/index.ts';
import { runStartup } from '../../src/cli/startup.ts';
import type { VerifierOutcome, VerifierRequest } from '../../src/controller/verifier.ts';
import { array, object } from '../../src/transport/wire.ts';
import { host, until } from '../support/host.ts';

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

  await controller.actions.startLoop(designdocReviewProtocol('doc.md', undefined, true), { from: 1, to: 2, score: 8, tries: 2 });
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
  // The path is namespaced by the run, so two clients reviewing the same round cannot collide.
  assert.match(request.file, /\.dsht\/verify\/[0-9a-f-]{36}\/designdoc-review-1-1\.json$/);
  assert.match(request.verificationId, /^[0-9a-f-]{36}\/designdoc-review\/1\/1$/);
  assert.ok(request.file.includes(request.verificationId.split('/')[0]!));
  assert.match(request.title, /^\[dsht-verify\]/);
  // The verifier's own prompt carries the file it must write and the rubric for this step.
  assert.match(request.prompt, /定位与范围/);
  // The prompt never names the file: the child owns persistence and reads the reply instead.
  assert.doesNotMatch(request.prompt, /把结论写入/);
  assert.match(request.prompt, /回复正文的最后输出唯一一个 JSON 对象/);
  assert.equal(controller.queries.loop?.best, 0, 'a new step starts its own best');
});

test('a verifier outage is retried and never lets the reply block pass', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'unavailable', reason: 'verifier wrote no verdict (exit 1)' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(designdocReviewProtocol('doc.md', undefined, true), { from: 1, to: 2, score: 8, tries: 2 });
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

test('a forked round with neither verdict nor block ends as verification unavailable', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const verifier = fakeVerifier(() => ({ type: 'unavailable', reason: 'verifier wrote no verdict (signal SIGKILL)' }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', verifier: verifier.port });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);

  await controller.actions.startLoop(designdocReviewProtocol('doc.md', undefined, true), { from: 1, to: 1, score: 8, tries: 1 });
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

  await controller.actions.startLoop(designdocReviewProtocol('doc.md', undefined, true), { from: 1, to: 2, score: 8, tries: 2 });
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
  await controller.actions.startLoop(designdocReviewProtocol('doc.md', undefined, controller.queries.forkedVerification), { from: 1, to: 1, score: 8, tries: 1 });
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

  await controller.actions.startLoop(designdocReviewProtocol('doc.md', undefined, true), { from: 1, to: 1, score: 8, tries: 5 });
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

  await controller.actions.startLoop(designdocReviewProtocol('doc.md', undefined, true), { from: 1, to: 2, score: 8, tries: 2 });
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
