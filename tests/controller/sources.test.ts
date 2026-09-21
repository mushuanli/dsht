/** The readable output sources a client knows, and the read-only view that follows one of them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../../src/controller/index.ts';
import { runStartup } from '../../src/cli/startup.ts';
import { readTrace } from '../../src/controller/trace-log.ts';
import type { VerifierOutcome, VerifierPort } from '../../src/controller/verifier.ts';
import { object } from '../../src/transport/wire.ts';
import { host, until, workspace } from '../support/host.ts';

/** A verifier that never judges; these tests are about lineage, not verdicts. */
const idleVerifier: VerifierPort = {
  name: 'dsht',
  verify: async (): Promise<VerifierOutcome> => ({ type: 'unavailable', reason: 'not used here' }),
};

/** Every follow address the client has opened so far, oldest first. */
function followedAddresses(fixture: Awaited<ReturnType<typeof host>>): ObjectValueAddress[] {
  return fixture.opens.filter(frame => frame.endpoint === 'session/follow')
    .map(frame => object(object(object(object(frame.payload).args).request).address) as ObjectValueAddress);
}

/** The address half of a `session/follow` request, as the fixture records it. */
type ObjectValueAddress = Record<string, unknown>;

test('a verifier session becomes a source that outlives the run', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', verifier: idleVerifier });
  t.after(async () => { await controller.stop(); });
  controller.start();
  // The reviewed conversation is selected first, so the verifier's session is a sibling of it.
  await runStartup(controller, { workspace: 'w1', session: 's1', commands: [], timeoutSeconds: 10 }, () => {});
  assert.equal(controller.queries.sources.length, 0);

  const sessionId = await controller.actions.createVerifierSession('[dsht-verify] designdoc review · 1/1');
  assert.equal(sessionId, 's-new');
  const source = controller.queries.sources.find(candidate => candidate.id === 's-new');
  assert.ok(source, 'the created verifier session must be offered as a source');
  // The title names the record and the attempt; the panel does not need the `[dsht-verify]` marker.
  assert.equal(source.label, 'designdoc review · 1/1');
  assert.equal(source.kind, 'session');
  assert.equal(source.createdBy, 'verifier');
  assert.equal(source.detail, 'verifier dsht');
  assert.equal(source.parentSessionId, 's1');
  assert.equal(source.state, 'running');

  assert.equal(await controller.actions.cancelVerifierSession('s-new'), true);
  // Stopping the run does not delete what it said: the source stays, marked finished.
  const ended = controller.queries.sources.find(candidate => candidate.id === 's-new');
  assert.ok(ended);
  assert.equal(ended.state, 'ended');
  assert.equal(typeof ended.endedAt, 'number');
});

test('leaving the conversation closes the read-only view', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', verifier: idleVerifier });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await runStartup(controller, { workspace: 'w1', session: 's1', commands: [], timeoutSeconds: 10 }, () => {});
  await controller.actions.createVerifierSession('[dsht-verify] designdoc review · 2/1');
  // The view belonged to the conversation that opened it; selecting another one releases it.
  controller.actions.openPeek('s-new');
  await until(() => controller.queries.peek !== undefined);
  await controller.actions.selectSession('s2');
  assert.equal(controller.queries.peek, undefined);
});

test('a host subagent child is a source, and the view follows it under its parent', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.subagent = { sessionId: 'child-1', origin: 'subagent', parentSessionId: 's1',
    projections: { values: { title: 'explore the parser' } } };
  // The child belongs to the selected workspace, which is the list a reader sees.
  fixture.baseline = [{ ...workspace, sessionIds: ['s1', 'child-1'] }];
  // The row does not say which delivery mode the child uses, so the client must try both.
  fixture.subagentMode = 'one-shot';
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);

  const child = controller.queries.sources.find(source => source.id === 'child-1');
  assert.ok(child, 'the host child must be listed');
  assert.equal(child.createdBy, 'agent');
  assert.equal(child.parentSessionId, 's1');
  assert.equal(child.label, 'explore the parser');
  // A host row reports no start time, so the source carries none rather than inventing one.
  assert.equal(child.startedAt, undefined);

  controller.actions.openPeek('child-1');
  await until(() => controller.queries.peek?.transcript !== undefined);
  await until(() => followedAddresses(fixture).length >= 2);
  assert.deepEqual(followedAddresses(fixture).slice(-2), [
    { kind: 'subagent', parentSessionId: 's1', childSessionId: 'child-1', mode: 'continuable' },
    { kind: 'subagent', parentSessionId: 's1', childSessionId: 'child-1', mode: 'one-shot' },
  ]);
  // What the child session streamed is what the view shows.
  fixture.follow({ type: 'event', event: { seq: 5, type: 'assistant/message', surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: 'the parser lives in parse.ts' }] } } } });
  await until(() => controller.queries.peek?.transcript?.messages.some(
    message => message.text.includes('the parser lives in parse.ts')) === true);

  const peek = controller.queries.peek;
  assert.equal(peek?.source.id, 'child-1');
  assert.equal(peek?.error, undefined);
  // Closing releases the stream; a view left scrolling must not hold a subscription open.
  const cancelled = fixture.cancels.length;
  controller.actions.closePeek();
  assert.equal(controller.queries.peek, undefined);
  // The cancel frame goes over the wire, so the host sees it a tick later.
  await until(() => fixture.cancels.length > cancelled);
});

test('a local ! run is a source with its own lines and needs no stream', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  const before = fixture.opens.filter(frame => frame.endpoint === 'session/follow').length;

  controller.shell.start('echo source-line');
  await until(() => controller.shell.runs[0]?.status === 'exited');
  const source = controller.queries.sources.find(candidate => candidate.kind === 'local');
  assert.ok(source, 'a local run must be offered as a source');
  assert.equal(source.id, `shell:${controller.shell.runs[0]!.id}`);
  assert.equal(source.label, '! echo source-line');
  assert.equal(source.createdBy, 'shell');
  assert.equal(source.state, 'ended');

  controller.actions.openPeek(source.id);
  const peek = controller.queries.peek;
  assert.ok(peek);
  assert.equal(peek.source.id, source.id);
  assert.ok(peek.lines?.some(line => line.includes('source-line')), 'the view shows what the run printed');
  assert.equal(peek.transcript, undefined);
  // Its content is already in this process, so opening it starts no host request.
  assert.equal(fixture.opens.filter(frame => frame.endpoint === 'session/follow').length, before);
  controller.actions.closePeek();
  assert.equal(controller.queries.peek, undefined);
});

test('an unknown source id opens nothing', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  controller.actions.openPeek('does-not-exist');
  assert.equal(controller.queries.peek, undefined);
  // Closing a view that was never opened is a no-op, not an error.
  controller.actions.closePeek();
  assert.equal(controller.queries.peek, undefined);
});

test('the trace records one begin and one end per viewed source', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const directory = await mkdtemp(join(tmpdir(), 'dsht-peek-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tracePath = join(directory, 'trace.log');
  const controller = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', tracePath });
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.queries.record.ready);
  controller.shell.start('echo traced');
  await until(() => controller.shell.runs[0]?.status === 'exited');
  const id = `shell:${controller.shell.runs[0]!.id}`;
  controller.actions.openPeek(id);
  controller.actions.closePeek();
  // The trace is written through a queue; stopping flushes it, so the read is deterministic.
  await controller.stop();
  const seen = (await readTrace(tracePath)).filter(line => !line.startsWith('#'))
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(entry => String(entry.event).startsWith('peek '));
  assert.deepEqual(seen.map(entry => entry.event), ['peek begin', 'peek end']);
  assert.equal(seen[0]!.source, id);
  assert.equal(seen[0]!.kind, 'local');
});
