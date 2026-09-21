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
  timeoutMs?: number;
  verbose?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-verify-'));
  const lines: string[] = [];
  const instance = new ProcessVerifier({
    command: ['/usr/bin/node', 'cli.js'], url: 'http://host', cwd: directory, env: {},
    timeoutMs: options.timeoutMs ?? 1000,
    createSession: options.createSession ?? (async () => 'session-verifier'),
    ...(options.cancelSession === undefined ? {} : { cancelSession: options.cancelSession }),
    onLine: line => lines.push(line),
    ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
    run: options.run as never,
  });
  // The reviewed workspace travels with each request, so a check never guesses from a process cwd.
  return { instance, directory, lines, request: { ...request, workspace: directory },
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const request = { verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, prompt: 'judge it', title: '[dsht-verify] 2/1',
  file: '' };

test('a child that reports a host request ends as needs-human and cancels the turn', async t => {
  const events: string[] = [];
  const fixture = await verifier({
    cancelSession: async (sessionId: string) => { events.push(`cancel:${sessionId}`); },
    run: async (_file, _args, io) => {
      io.onLine('dsht-verify-needs-human:{"kind":"approval","text":"Confirm the build"}', 'stderr');
      return { code: 3, signal: null };
    },
  });
  t.after(() => fixture.cleanup());
  const outcome = await fixture.instance.verify({ ...fixture.request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  // Blocked, not broken: the request travels back and the turn it left waiting is cancelled.
  assert.deepEqual(outcome, { type: 'needs-human', request: { kind: 'approval', text: 'Confirm the build' }, sessionId: 'session-verifier' });
  assert.deepEqual(events, ['cancel:session-verifier']);
});

test('a verdict the child writes is read back and tied to its round', async t => {
  const fixture = await verifier({ run: async () => ({ code: 0, signal: null }) });
  t.after(() => fixture.cleanup());
  const file = join(verdictDirectory(fixture.directory, 'run-1'), 'round.json');
  // The child is simulated by writing exactly what the prompt asks a verifier session to write.
  const outcome = await fixture.instance.verify({ ...fixture.request, file }, new AbortController().signal);
  assert.deepEqual(outcome, { type: 'unavailable', reason: 'verifier wrote no verdict (exit 0)', sessionId: 'session-verifier' });

  const writing = await verifier({ run: async () => {
    await writeFile(file, JSON.stringify({ verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, score: 7.5, status: 'retry' }));
    return { code: 0, signal: null };
  } });
  t.after(() => writing.cleanup());
  assert.deepEqual(await writing.instance.verify({ ...writing.request, file }, new AbortController().signal),
    { type: 'verified', result: { score: 7.5, status: 'retry' }, sessionId: 'session-verifier' });
});

test('a stale or unusable verdict file never scores the round', async t => {
  const stale = await verifier({ run: async () => ({ code: 0, signal: null }) });
  t.after(() => stale.cleanup());
  const target = join(verdictDirectory(stale.directory, 'run-1'), 'round.json');
  await mkdir(verdictDirectory(stale.directory, 'run-1'), { recursive: true });
  await writeFile(target, JSON.stringify({ verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 1, attempt: 1, score: 9, status: 'done' }));
  // Nothing is written this time, so the leftover file must not be read as this round's verdict.
  const staleOutcome = await stale.instance.verify({ ...stale.request, file: target }, new AbortController().signal);
  assert.deepEqual(staleOutcome, { type: 'unavailable', reason: 'verifier wrote no verdict (exit 0)', sessionId: 'session-verifier' });

  const garbled = await verifier({ run: async () => {
    await writeFile(target, '{"verificationId":"run-1/designdoc-review/2/1","kind":"designdoc-review","step":2,"attempt":1,"score":12}');
    return { code: 1, signal: null };
  } });
  t.after(() => garbled.cleanup());
  // An out-of-range score is dropped rather than trusted, so the verdict decides nothing.
  assert.deepEqual(await garbled.instance.verify({ ...garbled.request, file: target }, new AbortController().signal),
    { type: 'verified', result: {}, sessionId: 'session-verifier' });
});

test('the child receives the verifier session, the prompt and the waiting flags', async t => {
  let seen: readonly string[] = [];
  const fixture = await verifier({ run: async (_file, args) => { seen = args; return { code: 0, signal: null }; } });
  t.after(() => fixture.cleanup());
  await fixture.instance.verify({ ...fixture.request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
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
  const outcome = await fixture.instance.verify({ ...fixture.request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.deepEqual(outcome, { type: 'unavailable', reason: 'could not create a verifier session' });
  assert.equal(spawned, false);
});

test('a review cancelled before it starts never creates a session or a child', async t => {
  let created = 0;
  let spawned = false;
  const fixture = await verifier({
    createSession: async () => { created += 1; return 'session-verifier'; },
    run: async () => { spawned = true; return { code: 0, signal: null }; },
  });
  t.after(() => fixture.cleanup());
  const controller = new AbortController();
  controller.abort();
  // The review was cancelled, which is neither a verdict nor a verifier outage.
  const outcome = await fixture.instance.verify({ ...fixture.request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, controller.signal);
  assert.deepEqual(outcome, { type: 'cancelled' });
  assert.equal(created, 0);
  assert.equal(spawned, false);
});

test('cancelling while the verifier session is being created cancels it and never spawns', async t => {
  const events: string[] = [];
  let spawned = false;
  const fixture = await verifier({
    cancelSession: async (sessionId: string) => { events.push(`cancel:${sessionId}`); },
    createSession: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return 'session-verifier'; },
    run: async () => { spawned = true; return { code: 0, signal: null }; },
  });
  t.after(() => fixture.cleanup());
  const controller = new AbortController();
  const pending = fixture.instance.verify({ ...fixture.request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, controller.signal);
  setTimeout(() => controller.abort(), 1);
  // The session that appeared after the abort is cancelled, and no prompt is ever sent from it.
  assert.deepEqual(await pending, { type: 'cancelled' });
  assert.deepEqual(events, ['cancel:session-verifier']);
  assert.equal(spawned, false);
});

test('aborting a running child asks the host to cancel the turn it owns', async t => {
  const events: string[] = [];
  const controller = new AbortController();
  const fixture = await verifier({
    cancelSession: async (sessionId: string) => { events.push(`cancel:${sessionId}`); },
    run: async (_file, _args, io) => {
      events.push(`run:aborted=${String(io.signal.aborted)}`);
      controller.abort();
      return { code: null, signal: 'SIGTERM' };
    },
  });
  t.after(() => fixture.cleanup());
  const outcome = await fixture.instance.verify({ ...fixture.request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, controller.signal);
  // Killing the child proves nothing about the host's agent generation, so the host is asked too.
  assert.deepEqual(events, ['run:aborted=false', 'cancel:session-verifier']);
  assert.deepEqual(outcome, { type: 'cancelled' });
});

test('a verification timeout cancels the host turn too', async t => {
  const events: string[] = [];
  const fixture = await verifier({
    timeoutMs: 20,
    cancelSession: async (sessionId: string) => { events.push(`cancel:${sessionId}`); },
    run: async () => { await new Promise(resolve => setTimeout(resolve, 60)); events.push('run:finished'); return { code: null, signal: null }; },
  });
  t.after(() => fixture.cleanup());
  const outcome = await fixture.instance.verify({ ...fixture.request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.equal(events[0], 'cancel:session-verifier');
  assert.deepEqual(outcome, { type: 'unavailable', reason: 'verifier timed out after 20 ms · remote cancel confirmed', sessionId: 'session-verifier' });
});

test('a verdict that lands as the task times out never decides the attempt', async t => {
  const fixture = await verifier({
    timeoutMs: 20,
    run: async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      await mkdir(verdictDirectory(fixture.directory, 'run-1'), { recursive: true });
      await writeFile(join(verdictDirectory(fixture.directory, 'run-1'), 'r.json'), JSON.stringify({
        verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, score: 10, status: 'done' }));
      return { code: null, signal: 'SIGTERM' };
    },
  });
  t.after(() => fixture.cleanup());
  // An abandoned task must not be able to pass the round late, however good the file looks.
  const outcome = await fixture.instance.verify({ ...fixture.request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.equal(outcome.type, 'unavailable');
  assert.match((outcome as { reason: string }).reason, /timed out after 20 ms/);
});

test('a host that refuses the cancel is reported, and the local run still ends', async t => {
  const fixture = await verifier({
    timeoutMs: 20,
    cancelSession: async () => { throw new Error('gateway/method-unavailable'); },
    run: async () => { await new Promise(resolve => setTimeout(resolve, 60)); return { code: null, signal: null }; },
  });
  t.after(() => fixture.cleanup());
  const outcome = await fixture.instance.verify({ ...fixture.request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.deepEqual(outcome, { type: 'unavailable', reason: 'verifier timed out after 20 ms · remote cancel rejected',
    sessionId: 'session-verifier', retryable: false });
});

test('a host that never answers the cancel does not hold the local run open', async t => {
  const fixture = await verifier({
    timeoutMs: 20,
    cancelSession: () => new Promise<void>(() => { /* a host that never answers */ }),
    run: async () => { await new Promise(resolve => setTimeout(resolve, 60)); return { code: null, signal: null }; },
  });
  t.after(() => fixture.cleanup());
  const outcome = await fixture.instance.verify({ ...fixture.request, file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  // Bounded: the local run ends even though the remote cancellation was never confirmed, and the
  // caller is told not to retry into a remote turn that may still be running.
  assert.equal(outcome.type, 'unavailable');
  assert.match((outcome as { reason: string }).reason, /remote cancel unconfirmed after 1000 ms/);
  assert.equal((outcome as { sessionId?: string }).sessionId, 'session-verifier');
  assert.equal((outcome as { retryable?: boolean }).retryable, false);
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
  const outcome = await fixture.instance.verify({ ...fixture.request, artifact: 'doc.md',
    file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  // Prompt-level "do not modify" is not an invariant; a changed artifact voids the verdict. The
  // reason states which file and which content, without claiming who changed it.
  assert.equal(outcome.type, 'unavailable');
  assert.match((outcome as { reason: string }).reason, /^reviewed artifact changed during verification \(doc\.md · [0-9a-f]{8} → [0-9a-f]{8}\)$/);
  assert.equal((outcome as { sessionId?: string }).sessionId, 'session-verifier');
});

test('the artifact checked is the workspace the request declares', async t => {
  const reviewed = await mkdtemp(join(tmpdir(), 'dsht-reviewed-'));
  const other = await mkdtemp(join(tmpdir(), 'dsht-other-'));
  t.after(async () => {
    await rm(reviewed, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  });
  const fixture = await verifier({ run: async () => {
    // The reviewed workspace is written during verification; the verifier's own directory is not.
    await writeFile(join(reviewed, 'doc.md'), 'rewritten under review');
    await writeFile(join(verdictDirectory(fixture.directory, 'run-1'), 'r.json'), JSON.stringify({
      verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, score: 9, status: 'done' }));
    return { code: 0, signal: null };
  } });
  t.after(() => fixture.cleanup());
  await writeFile(join(reviewed, 'doc.md'), 'the artifact under review');
  // Same relative name, different content, in the directory this process runs in: a check that
  // inferred its path from the process would compare the wrong file and pass the round.
  await writeFile(join(fixture.directory, 'doc.md'), 'the artifact under review');

  const outcome = await fixture.instance.verify({ ...fixture.request, workspace: reviewed, artifact: 'doc.md',
    file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.equal(outcome.type, 'unavailable');
  assert.match((outcome as { reason: string }).reason, /^reviewed artifact changed during verification \(doc\.md ·/);
});

test('an unchanged artifact leaves the verdict intact', async t => {
  const fixture = await verifier({ run: async () => {
    await writeFile(join(verdictDirectory(fixture.directory, 'run-1'), 'r.json'), JSON.stringify({
      verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, score: 6, status: 'retry' }));
    return { code: 0, signal: null };
  } });
  t.after(() => fixture.cleanup());
  await writeFile(join(fixture.directory, 'doc.md'), 'the artifact under review');
  const outcome = await fixture.instance.verify({ ...fixture.request, artifact: 'doc.md',
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
  const outcome = await fixture.instance.verify({ ...fixture.request, artifact: 'not-here.md',
    file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.equal(outcome.type, 'verified');
});

test('a child that dies without a verdict reports why as facts, not as its own output', async t => {
  const fixture = await verifier({ run: async (_file, _args, io) => {
    io.onLine('connecting to the host…', 'stdout');
    io.onLine('Error: /home/li/prj/private.md: cannot read config, token=abc123', 'stderr');
    return { code: 1, signal: null };
  } });
  t.after(() => fixture.cleanup());
  // The reason reaches the progress line and the trace, and that log may be pasted into a report, so
  // it carries the class of the failure rather than the child's words.
  const outcome = await fixture.instance.verify({ ...fixture.request,
    file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  // A line that mentions a token classifies as `auth`, which is the more actionable half.
  assert.deepEqual(outcome, { type: 'unavailable',
    reason: 'verifier wrote no verdict (exit 1) · stderrClass auth', sessionId: 'session-verifier' });
  assert.doesNotMatch(JSON.stringify(outcome), /private\.md|abc123/);
});

test('only an explicit request quotes the child, and then only after sanitizing it', async t => {
  const fixture = await verifier({ verbose: true, run: async (_file, _args, io) => {
    io.onLine('Error: /home/li/prj/private.md: cannot read the config in loop.yaml', 'stderr');
    return { code: 1, signal: null };
  } });
  t.after(() => fixture.cleanup());
  const outcome = await fixture.instance.verify({ ...fixture.request,
    file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
  assert.equal(outcome.type, 'unavailable');
  const reason = outcome.type === 'unavailable' ? outcome.reason : '';
  assert.match(reason, /^verifier wrote no verdict \(exit 1\) · stderrClass config · /);
  assert.doesNotMatch(reason, /private\.md/);
  assert.match(reason, /<path>/);
});

test('the output class names the failure an operator can act on', async t => {
  const cases: [string, string][] = [
    ['Error: 401 unauthorized, set DSH_TOKEN', 'auth'],
    ['Error: connect ECONNREFUSED 127.0.0.1:3080', 'host'],
    ['Error: invalid config in loop.yaml', 'config'],
    ['Error: something odd happened', 'unknown'],
  ];
  for (const [line, expected] of cases) {
    const fixture = await verifier({ run: async (_file, _args, io) => {
      io.onLine(line, 'stderr');
      return { code: 1, signal: null };
    } });
    t.after(() => fixture.cleanup());
    const outcome = await fixture.instance.verify({ ...fixture.request,
      file: join(verdictDirectory(fixture.directory, 'run-1'), 'r.json') }, new AbortController().signal);
    assert.equal(outcome.type === 'unavailable' ? outcome.reason : '', 
      `verifier wrote no verdict (exit 1) · stderrClass ${expected}`, line);
  }
});
