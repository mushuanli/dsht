/** Startup automation: workspace, session and slash lines driven without the terminal interface. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller/index.ts';
import { runStartup } from '../../src/cli/startup.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorText } from '../../src/transport/wire.ts';
import { host, until } from '../support/host.ts';

/** One durable assistant reply carrying a result block. */
function reply(fixture: Awaited<ReturnType<typeof host>>, seq: number, status: string, score?: number,
  reason?: string): void {
  const body = JSON.stringify({ kind: 'designdoc-review', step: 1, attempt: 1,
    ...(score === undefined ? {} : { score }), status, ...(reason === undefined ? {} : { reason }) });
  fixture.follow({ type: 'event', event: { seq, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: `round result\n\`\`\`dsht-loop\n${body}\n\`\`\`` }] } } } });
}

test('startup picks the workspace, creates a session and follows the loop to its verdict', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  // The reviewed document carries the round's own section, which the client checks before accepting.
  const workspace = await mkdtemp(join(tmpdir(), 'dsht-startup-'));
  await writeFile(join(workspace, 'DESIGN-DOC-REVIEW.md'), '## 第 1 轮 · 定位与范围\nround one\n');
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', localDirectory: workspace });
  t.after(async () => { await controller.stop(); });
  controller.start();

  const lines: string[] = [];
  const running = runStartup(controller, {
    workspace: 'w1', session: 'new',
    commands: ['/loop designdoc-review --to 1 --tries 2'],
    timeoutSeconds: 10,
  }, line => lines.push(line));
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  // The plan selected the workspace, created a session and started the review there.
  assert.equal(controller.state.screen, 'chat');
  assert.ok(controller.state.sessionId);
  assert.equal(controller.queries.loop?.stepLabel, '定位与范围');
  // The notice is logged after the command resolves, so wait for it rather than race the prompt.
  await until(() => lines.some(line => line.includes('Designdoc review · tui-design.md started')));

  reply(fixture, 40, 'done', 9);
  await until(() => controller.queries.record.messages.some(message => message.text.includes('dsht-loop')));
  fixture.emit({ type: 'emit', event: 'api-session/status', args: [controller.state.sessionId ?? '', false] });
  assert.equal(await running, 'passed');
  // A pass over a selected range says which rounds it covered instead of claiming the whole record.
  assert.ok(lines.some(line => line.includes('Loop passed · round 1/10 · selected range')));
});

test('a blocked verdict makes the startup run fail', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  t.after(async () => { await controller.stop(); });
  controller.start();

  const lines: string[] = [];
  const running = runStartup(controller, {
    workspace: 'w1', session: 'new',
    commands: ['/loop designdoc-review --to 1 --tries 2'],
    timeoutSeconds: 10,
  }, line => lines.push(line));
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  reply(fixture, 41, 'blocked', undefined, '文档之间仍有无法调和的矛盾');
  await until(() => controller.queries.record.messages.some(message => message.text.includes('blocked')));
  fixture.emit({ type: 'emit', event: 'api-session/status', args: [controller.state.sessionId ?? '', false] });
  assert.equal(await running, 'failed');
  assert.ok(lines.some(line => line.includes('Loop blocked')));
});

test('a malformed or unknown startup line fails instead of running', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await assert.rejects(() => runStartup(controller, {
    workspace: 'w1', session: 'new', commands: ['/definitely-not-a-command'], timeoutSeconds: 5,
  }, () => {}), /Unknown command/);
});

test('a startup line the application would refuse fails before it reaches the host', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  // The scripted half runs the same authorize the composer does, so a line that needs a settled
  // conversation is refused here too instead of being handed to a host that is mid-turn.
  fixture.onPage = async () => { await new Promise<void>(resolve => setTimeout(resolve, 500)); return { records: [], hasMore: false }; };
  const running = runStartup(controller, {
    workspace: 'w1', session: 'new', commands: ['/compact'], timeoutSeconds: 5,
  }, () => {}).then(() => 'finished', error => errorText(error));
  await until(() => controller.state.sessionId !== undefined && controller.queries.record.ready);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: [controller.state.sessionId ?? '', true] });
  await until(() => controller.queries.running);
  assert.match(String(await running), /Wait for the running turn to finish/);
});

test('a plain prompt waits for its turn so a forked child exits by itself', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  t.after(async () => { await controller.stop(); });
  controller.start();

  const lines: string[] = [];
  const running = runStartup(controller, {
    workspace: 'w1', session: 'new', prompt: 'verify round 1 and write the verdict',
    wait: true, commands: [], timeoutSeconds: 10,
  }, line => lines.push(line));
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const sessionId = controller.state.sessionId ?? '';
  assert.equal(controller.queries.running, false);

  // The host acknowledges the prompt before working, and the turn is only over once it is idle again.
  fixture.emit({ type: 'emit', event: 'api-session/status', args: [sessionId, true] });
  await until(() => controller.queries.running);
  let settled = false;
  void running.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false);
  fixture.emit({ type: 'emit', event: 'api-session/status', args: [sessionId, false] });
  assert.equal(await running, 'idle');
  assert.ok(lines.some(line => line.includes('Turn finished')));
});

test('waiting for the connection means the startup picker has already settled', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  // A caller that acts on `online` alone can be overwritten by the picker that runs after it, so the
  // usable signal is the settled one: by then the selection this client started with is in place.
  await until(() => controller.state.online && controller.queries.connectionSettled);
  assert.equal(controller.state.screen, 'chat');
  assert.equal(controller.state.sessionId, 's1');
});

test('only a turn the host was seen starting counts as finished', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.connectionSettled);
  const before = controller.queries.turnsCompleted;

  // A replayed or duplicated idle frame must not look like a finished turn.
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(controller.queries.turnsCompleted, before);

  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await until(() => controller.queries.turnsCompleted === before + 1);

  // A second idle with no busy edge in between is still not a new turn.
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(controller.queries.turnsCompleted, before + 1);
});

test('a verifier blocked on a host request stops and reports it instead of timing out', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  const directory = await mkdtemp(join(tmpdir(), 'dsht-verdict-'));
  const file = join(directory, 'verdict.json');
  const lines: string[] = [];
  const running = runStartup(controller, { workspace: 'w1', session: 'new', prompt: 'judge it', wait: true,
    verdict: { file, identity: 'run-7/designdoc-review/1/1' }, commands: [], timeoutSeconds: 30 }, line => lines.push(line));
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const sessionId = controller.state.sessionId ?? '';
  // A headless verifier cannot answer an approval, so the host is left waiting.
  fixture.emit({ type: 'waterfall', event: 'approval/request', eventId: 'approve-1', agentId: sessionId,
    request: { toolName: 'bash', reason: 'Confirm the test command' } });

  assert.equal(await running, 'needs-human');
  const marker = lines.find(line => line.startsWith('dsht-verify-needs-human:'));
  assert.ok(marker, 'the child reports what the host is waiting for');
  const request = JSON.parse(marker.slice('dsht-verify-needs-human:'.length)) as { kind: string; text: string };
  assert.equal(request.kind, 'approval');
  assert.match(request.text, /Confirm the test command/);
  // A turn that never finished has no verdict to write.
  await assert.rejects(readFile(file, 'utf8'));
  await rm(directory, { recursive: true, force: true });
});

test('a verdict block that predates the prompt is never used as this turn\'s reply', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.online && controller.queries.record.ready);
  // A perfectly good verdict already sits in the transcript, from an earlier turn, declaring the
  // very identity this run is waiting for. Only "it arrived after the prompt" can reject it.
  const identity = 'run-8/designdoc-review/1/1';
  const body = JSON.stringify({ verificationId: identity, kind: 'designdoc-review', step: 1, attempt: 1, score: 10, status: 'done' });
  fixture.follow({ type: 'event', event: { seq: 80, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: `old result\n\`\`\`dsht-loop\n${body}\n\`\`\`` }] } } } });
  await until(() => controller.queries.record.messages.some(message => message.text.includes('dsht-loop')));

  const directory = await mkdtemp(join(tmpdir(), 'dsht-verdict-'));
  const file = join(directory, 'verdict.json');
  const lines: string[] = [];
  const running = runStartup(controller, { workspace: 'w1', session: 's1', prompt: 'judge it', wait: true,
    verdict: { file, identity }, commands: [], timeoutSeconds: 10 }, line => lines.push(line));
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  // The turn really ends, but nothing is committed for this prompt: the idle edge is not enough.
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', true] });
  fixture.emit({ type: 'emit', event: 'api-session/status', args: ['s1', false] });

  assert.equal(await running, 'idle');
  await assert.rejects(readFile(file, 'utf8'));
  assert.ok(lines.some(line => line.includes('no reply was committed after the prompt')));
  await rm(directory, { recursive: true, force: true });
});

test('the child writes the verdict its own reply declared, through an atomic rename', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  const directory = await mkdtemp(join(tmpdir(), 'dsht-verdict-'));
  const file = join(directory, 'verdict.json');
  const identity = 'run-9/designdoc-review/1/1';
  const running = runStartup(controller, { workspace: 'w1', session: 'new', prompt: 'judge it', wait: true,
    verdict: { file, identity }, commands: [], timeoutSeconds: 10 }, () => {});
  await until(() => fixture.calls.some(call => call.method === 'session/prompt'));
  const sessionId = controller.state.sessionId ?? '';
  const body = JSON.stringify({ verificationId: identity, kind: 'designdoc-review', step: 1, attempt: 1,
    score: 6.5, status: 'retry', evidence: 'checked it', top_findings: ['A 未解决', 'B 未解决'] });
  fixture.follow({ type: 'event', event: { seq: 90, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: `done\n\`\`\`dsht-loop\n${body}\n\`\`\`` }] } } } });
  fixture.emit({ type: 'emit', event: 'api-session/status', args: [sessionId, true] });
  fixture.emit({ type: 'emit', event: 'api-session/status', args: [sessionId, false] });
  assert.equal(await running, 'idle');

  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    verificationId: identity, kind: 'designdoc-review', step: 1, attempt: 1, score: 6.5, status: 'retry',
    evidence: 'checked it', top_findings: ['A 未解决', 'B 未解决'],
  });
  // Renamed into place, so a reader never sees a half-written verdict and no part file survives.
  await assert.rejects(readFile(`${file}.part`, 'utf8'));
  await rm(directory, { recursive: true, force: true });
});
