/** The forked verifier: session, child process and the verdict file that comes back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessVerifier } from '../../src/cli/verifier.ts';
import { verdictDirectory } from '../../src/controller/verifier.ts';
import type { ShellRunOptions } from '../../src/shell/index.ts';

/** One verifier under test, with the child process replaced by a scripted runner. */
async function verifier(options: { run: (file: string, args: readonly string[], io: ShellRunOptions) => Promise<{ code: number | null; signal: string | null }>;
  createSession?: (title: string) => Promise<string | undefined>;
  cancelSession?: (sessionId: string) => Promise<void>;
  timeoutMs?: number }) {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-verify-'));
  const lines: string[] = [];
  const instance = new ProcessVerifier({
    command: ['/usr/bin/node', 'cli.js'], url: 'http://host', directory, cwd: directory, env: {},
    timeoutMs: options.timeoutMs ?? 1000,
    createSession: options.createSession ?? (async () => 'session-verifier'),
    ...(options.cancelSession === undefined ? {} : { cancelSession: options.cancelSession }),
    onLine: line => lines.push(line),
    run: options.run as never,
  });
  return { instance, directory, lines, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const request = { verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, prompt: 'judge it', title: '[dsht-verify] 2/1',
  file: '' };

test('a verdict the child writes is read back and tied to its round', async t => {
  const fixture = await verifier({ run: async () => ({ code: 0, signal: null }) });
  t.after(() => fixture.cleanup());
  const file = join(verdictDirectory(fixture.directory, 'run-1'), 'round.json');
  // The child is simulated by writing exactly what the prompt asks a verifier session to write.
  const outcome = await fixture.instance.verify({ ...request, file }, new AbortController().signal);
  assert.deepEqual(outcome, { type: 'unavailable', reason: 'verifier wrote no verdict (exit 0)', sessionId: 'session-verifier' });

  const writing = await verifier({ run: async () => {
    await writeFile(file, JSON.stringify({ verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, score: 7.5, status: 'retry' }));
    return { code: 0, signal: null };
  } });
  t.after(() => writing.cleanup());
  assert.deepEqual(await writing.instance.verify({ ...request, file }, new AbortController().signal),
    { type: 'verified', result: { score: 7.5, status: 'retry' }, sessionId: 'session-verifier' });
});

test('a stale or unusable verdict file never scores the round', async t => {
  const stale = await verifier({ run: async () => ({ code: 0, signal: null }) });
  t.after(() => stale.cleanup());
  const target = join(verdictDirectory(stale.directory, 'run-1'), 'round.json');
  await mkdir(verdictDirectory(stale.directory, 'run-1'), { recursive: true });
  await writeFile(target, JSON.stringify({ verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 1, attempt: 1, score: 9, status: 'done' }));
  // Nothing is written this time, so the leftover file must not be read as this round's verdict.
  const staleOutcome = await stale.instance.verify({ ...request, file: target }, new AbortController().signal);
  assert.deepEqual(staleOutcome, { type: 'unavailable', reason: 'verifier wrote no verdict (exit 0)', sessionId: 'session-verifier' });

  const garbled = await verifier({ run: async () => {
    await writeFile(target, '{"verificationId":"run-1/designdoc-review/2/1","kind":"designdoc-review","step":2,"attempt":1,"score":12}');
    return { code: 1, signal: null };
  } });
  t.after(() => garbled.cleanup());
  // An out-of-range score is dropped rather than trusted, so the verdict decides nothing.
  assert.deepEqual(await garbled.instance.verify({ ...request, file: target }, new AbortController().signal),
    { type: 'verified', result: {}, sessionId: 'session-verifier' });
});

test('the child receives the verifier session, the prompt and the waiting flags', async t => {
  let seen: readonly string[] = [];
  const fixture = await verifier({ run: async (_file, args) => { seen = args; return { code: 0, signal: null }; } });
  t.after(() => fixture.cleanup());
  await fixture.instance.verify({ ...request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.ok(seen.includes('--session') && seen[seen.indexOf('--session') + 1] === 'session-verifier');
  assert.equal(seen[seen.indexOf('--prompt') + 1], 'judge it');
  assert.ok(seen.includes('--wait') && seen.includes('--headless'));
  // The child owns the protocol file: it is told where to write the verdict and which identity to
  // declare, instead of asking the model to choose a path and open the file.
  assert.equal(seen[seen.indexOf('--verdict') + 1], join(verdictDirectory(fixture.directory, 'run-1'), 'r.json'));
  assert.equal(seen[seen.indexOf('--verdict-identity') + 1], request.verificationId);
});

test('a missing verifier session ends the attempt with a note instead of spawning', async t => {
  let spawned = false;
  const fixture = await verifier({ createSession: async () => undefined,
    run: async () => { spawned = true; return { code: 0, signal: null }; } });
  t.after(() => fixture.cleanup());
  const outcome = await fixture.instance.verify({ ...request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.deepEqual(outcome, { type: 'unavailable', reason: 'could not create a verifier session' });
  assert.equal(spawned, false);
});

test('cancelling the review cancels the child', async t => {
  const fixture = await verifier({ run: async (_file, _args, io) => {
    assert.equal(io.signal.aborted, true);
    return { code: null, signal: 'SIGTERM' };
  } });
  t.after(() => fixture.cleanup());
  const controller = new AbortController();
  controller.abort();
  // The review was cancelled, which is neither a verdict nor a verifier outage.
  const outcome = await fixture.instance.verify({ ...request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, controller.signal);
  assert.deepEqual(outcome, { type: 'cancelled' });
});

test('aborting a verification cancels the host turn before the child dies', async t => {
  const events: string[] = [];
  const fixture = await verifier({
    cancelSession: async (sessionId: string) => { events.push(`cancel:${sessionId}`); },
    run: async (_file, _args, io) => { events.push(`run:aborted=${String(io.signal.aborted)}`); return { code: null, signal: 'SIGTERM' }; },
  });
  t.after(() => fixture.cleanup());
  const controller = new AbortController();
  const pending = fixture.instance.verify({ ...request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, controller.signal);
  controller.abort();
  await pending;
  // Killing the child proves nothing about the host's agent generation, so the host is told first.
  assert.deepEqual(events, ['cancel:session-verifier', 'run:aborted=true']);
});

test('a verification timeout cancels the host turn too', async t => {
  const events: string[] = [];
  const fixture = await verifier({
    timeoutMs: 20,
    cancelSession: async (sessionId: string) => { events.push(`cancel:${sessionId}`); },
    run: async () => { await new Promise(resolve => setTimeout(resolve, 60)); events.push('run:finished'); return { code: null, signal: null }; },
  });
  t.after(() => fixture.cleanup());
  const outcome = await fixture.instance.verify({ ...request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.equal(events[0], 'cancel:session-verifier');
  assert.deepEqual(outcome, { type: 'unavailable', reason: 'verifier timed out after 20 ms', sessionId: 'session-verifier' });
});

test('a host that cannot cancel still leaves no orphaned child', async t => {
  const fixture = await verifier({
    cancelSession: async () => { throw new Error('gateway/method-unavailable'); },
    run: async (_file, _args, io) => { assert.equal(io.signal.aborted, true); return { code: null, signal: 'SIGTERM' }; },
  });
  t.after(() => fixture.cleanup());
  const controller = new AbortController();
  controller.abort();
  // The review was cancelled, which is neither a verdict nor a verifier outage.
  const outcome = await fixture.instance.verify({ ...request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, controller.signal);
  assert.deepEqual(outcome, { type: 'cancelled' });
});

test('a verifier that changed the reviewed artifact invalidates its own verdict', async t => {
  const fixture = await verifier({ run: async () => {
    await writeFile(join(fixture.directory, 'doc.md'), 'the verifier rewrote it');
    await writeFile(join(verdictDirectory(fixture.directory, 'run-1'), 'r.json'), JSON.stringify({
      verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, score: 9, status: 'done' }));
    return { code: 0, signal: null };
  } });
  t.after(() => fixture.cleanup());
  await writeFile(join(fixture.directory, 'doc.md'), 'the artifact under review');
  const outcome = await fixture.instance.verify({ ...request, artifact: 'doc.md',
    file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  // Prompt-level "do not modify" is not an invariant; a changed artifact voids the verdict.
  assert.deepEqual(outcome, { type: 'unavailable', reason: 'verifier modified the reviewed artifact', sessionId: 'session-verifier' });
});

test('an unchanged artifact leaves the verdict intact', async t => {
  const fixture = await verifier({ run: async () => {
    await writeFile(join(verdictDirectory(fixture.directory, 'run-1'), 'r.json'), JSON.stringify({
      verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, score: 6, status: 'retry' }));
    return { code: 0, signal: null };
  } });
  t.after(() => fixture.cleanup());
  await writeFile(join(fixture.directory, 'doc.md'), 'the artifact under review');
  const outcome = await fixture.instance.verify({ ...request, artifact: 'doc.md',
    file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.deepEqual(outcome, { type: 'verified', result: { score: 6, status: 'retry' }, sessionId: 'session-verifier' });
});

test('an artifact this client cannot read skips the check instead of failing the verdict', async t => {
  const fixture = await verifier({ run: async () => {
    await writeFile(join(verdictDirectory(fixture.directory, 'run-1'), 'r.json'), JSON.stringify({
      verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, score: 7, status: 'retry' }));
    return { code: 0, signal: null };
  } });
  t.after(() => fixture.cleanup());
  // A remote host's workspace is not on this filesystem, so there is nothing to compare.
  const outcome = await fixture.instance.verify({ ...request, artifact: 'not-here.md',
    file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.equal(outcome.type, 'verified');
});
