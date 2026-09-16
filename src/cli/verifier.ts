/** Verification by a child `dsht` process: its own session, its own context, a file back.
 *
 * The reviewed session cannot judge itself fairly, and an in-host subagent still shares the process
 * that produced the work. This implementation forks the client itself, points the child at a fresh
 * named session, and reads the verdict file that session writes — so the verdict arrives through a
 * file written on disk rather than through the reviewer's own reply.
 */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { runProcess } from '../shell/index.ts';
import { ensureDirectory, readText, removeFile } from '../storage/index.ts';
import { parseVerdict } from '../controller/loop-contract.ts';

import type { VerifierOutcome, VerifierPort, VerifierRequest } from '../controller/verifier.ts';

/** Everything a forked verification needs from the client that owns it. */
export interface ProcessVerifierOptions {
  /** Program and arguments that start this client again: exec path, exec arguments, entry script. */
  command: readonly string[];
  /** Host URL as the operator gave it, so the child authenticates the same way. */
  url: string;
  /** Cookie directory the parent used, when it was explicit. */
  authDir?: string;
  /** Directory the verdict files are written under, inside the reviewed workspace. */
  directory: string;
  /** Working directory for the child. */
  cwd: string;
  /** Environment for the child; it inherits the parent's, including DSH_TOKEN. */
  env: NodeJS.ProcessEnv;
  /** How long one verification may run. */
  timeoutMs: number;
  /** Creates the verifier's own session and names it; the controller owns the connection. */
  createSession(title: string): Promise<string | undefined>;
  /** Stops that session's turn on the host; without it a killed child leaves the agent running. */
  cancelSession?(sessionId: string): Promise<void>;
  /** Receives the child's output lines, so the parent can log why a verdict is missing. */
  onLine(line: string, stream: 'stdout' | 'stderr'): void;
  /** Process runner, injectable so the logic can be tested without spawning a client. */
  run?: typeof runProcess;
}

/** Content fingerprint of a workspace file, or undefined when it cannot be read from here.
 *
 * A remote host's workspace is not on this filesystem, so an unreadable artifact means the check
 * cannot be made — which is reported as a boundary rather than treated as tampering.
 * @param path - Absolute path of the file.
 * @returns SHA-256 of its text, or undefined when it is not readable.
 */
async function fingerprint(path: string): Promise<string | undefined> {
  const text = await readText(path);
  return text === undefined ? undefined : createHash('sha256').update(text).digest('hex');
}

/** Run one verifier as a child client and read the file it leaves behind.
 *
 * The child is the same program as the parent but a different session, so it starts from an empty
 * context: the prompt, the standard and the artifact on disk are all it knows.
 */
export class ProcessVerifier implements VerifierPort {
  constructor(private readonly options: ProcessVerifierOptions) {}

  /** @param request - Round identity, prompt and verdict path.
   *  @param signal - Cancels the child; the run also stops at its own deadline.
   *  @returns The verdict read back from the file, or a note explaining its absence.
   */
  async verify(request: VerifierRequest, signal: AbortSignal): Promise<VerifierOutcome> {
    const run = this.options.run ?? runProcess;
    const file = request.file;
    await ensureDirectory(dirname(file));
    // A verdict left by an earlier run must never be read as this one's.
    await removeFile(file);
    // "Do not modify the artifact" is an instruction until it can be checked: fingerprint it when
    // the workspace is readable from here, and let a changed artifact invalidate the verdict.
    const artifactPath = request.artifact === undefined ? undefined : join(this.options.directory, request.artifact);
    const before = artifactPath === undefined ? undefined : await fingerprint(artifactPath);
    const sessionId = await this.options.createSession(request.title);
    if (sessionId === undefined) return { type: 'unavailable', reason: 'could not create a verifier session' };

    const [program, ...leading] = this.options.command;
    if (program === undefined) return { type: 'unavailable', reason: 'no client entry to fork' };
    const args = [...leading,
      '--url', this.options.url,
      ...(this.options.authDir === undefined ? [] : ['--auth-dir', this.options.authDir]),
      '--session', sessionId,
      '--prompt', request.prompt,
      // The child judges and this client owns the protocol file, so the verdict is written by the
      // child from its own reply rather than by the model choosing a path and opening a file.
      '--verdict', file, '--verdict-identity', request.verificationId,
      '--wait', '--headless', '--no-memory-log'];

    // The child stops when its session's turn ends, but a stuck host must not hold the review open.
    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    // The host owns the turn, so the child dying proves nothing about it: cancel there first, and
    // only then terminate the local waiter. A host that cannot cancel still gets a killed child.
    const stop = (): void => {
      void this.options.cancelSession?.(sessionId).catch(() => { /* the child is killed regardless */ });
      controller.abort();
    };
    const onAbort = (): void => { cancelled = true; stop(); };
    const onTimeout = (): void => { timedOut = true; stop(); };
    const timer = setTimeout(onTimeout, this.options.timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const exit = await run(program, args, {
        cwd: this.options.cwd, env: this.options.env, signal: controller.signal, onLine: this.options.onLine,
      });
      // A cancelled review decides nothing, and is not a verifier outage either.
      if (cancelled) return { type: 'cancelled' };
      const text = await readText(file);
      if (text === undefined) {
        if (timedOut) return { type: 'unavailable', reason: `verifier timed out after ${this.options.timeoutMs} ms`, sessionId };
        const why = exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `exit ${exit.code}`;
        return { type: 'unavailable', reason: `verifier wrote no verdict (${why})`, sessionId };
      }
      if (before !== undefined) {
        const after = artifactPath === undefined ? undefined : await fingerprint(artifactPath);
        if (after !== before) return { type: 'unavailable', reason: 'verifier modified the reviewed artifact', sessionId };
      }
      const result = parseVerdict(text, { verificationId: request.verificationId,
        kind: request.kind, step: request.step, attempt: request.attempt });
      if (result === undefined) return { type: 'unavailable', reason: 'verifier verdict was unusable', sessionId };
      return { type: 'verified', result, sessionId };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
