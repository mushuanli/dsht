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
import { sanitizeTraceText } from '../text.ts';

import type { VerificationHumanRequest, VerifierOutcome, VerifierPort, VerifierRequest } from '../controller/verifier.ts';
import { parseNeedsHumanLine } from '../controller/verifier.ts';

/** How long a cancellation request may wait for the host's answer before local cleanup proceeds. */
const CANCEL_CONFIRM_MS = 1_000;
/** How much of the child's error output is kept to classify it; the text itself is never reported. */
const VERIFIER_STDERR_LIMIT = 4_096;

/** What a child's error output says about why it failed, without carrying the output itself.
 *
 * A reason travels into the progress line, the verdict summary and the trace, and that log may be
 * pasted into a report; the child's own words can name paths, projects or credentials. The class is
 * the actionable half: `auth` and `host` are worth retrying differently, `config` never is.
 */
export type VerifierStderrClass = 'auth' | 'host' | 'config' | 'unknown';

/** Classify a child's captured error output.
 * @param text - Everything the child wrote to stderr, bounded by the caller.
 * @returns The most actionable class the output matches.
 */
export function classifyVerifierOutput(text: string): VerifierStderrClass {
  if (/unauthor|forbidden|401|403|credential|log ?in|token/i.test(text)) return 'auth';
  if (/econnrefused|econnreset|enotfound|fetch failed|timed? ?out|socket|50[234]|unreachable/i.test(text)) return 'host';
  if (/config|yaml|invalid|missing|enoent|no such file|usage|unknown option/i.test(text)) return 'config';
  return 'unknown';
}

/** The faults this client's own child reports on stderr, named so a missing verdict explains itself.
 *
 * These sentences are written by `runStartup` in this same program, so naming them leaks nothing and
 * needs no model text: the alternative is the keyword class below, which reads our own diagnosis as
 * `unknown`. Anything else the child writes still goes through that class.
 */
const CHILD_FAULTS: readonly { pattern: RegExp; note: string }[] = [
  { pattern: /no parsable verdict in the reply/i, note: 'no JSON verdict in the reply' },
  { pattern: /no reply was committed after the prompt/i, note: 'no reply committed after the turn' },
];

/** Name the fault the child reported about itself, when this client wrote that line.
 * @param text - Everything the child wrote to stderr.
 * @returns The fault as one clause, or undefined when nothing recognized is there.
 */
export function childFault(text: string): string | undefined {
  return CHILD_FAULTS.find(fault => fault.pattern.test(text))?.note;
}

/** Everything a forked verification needs from the client that owns it. */
export interface ProcessVerifierOptions {
  /** Program and arguments that start this client again: exec path, exec arguments, entry script. */
  command: readonly string[];
  /** Host URL as the operator gave it, so the child authenticates the same way. */
  url: string;
  /** Cookie directory the parent used, when it was explicit. */
  authDir?: string;
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
  /** Quote the child's own (sanitized) words in a reason; off by default because that text leaves. */
  verbose?: boolean;
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
  /** This client forks itself, so the harness that judges is this one. */
  readonly name = 'dsht';
  constructor(private readonly options: ProcessVerifierOptions) {}

  /** @param request - Round identity, prompt and verdict path.
   *  @param signal - Cancels the child; the run also stops at its own deadline.
   *  @returns The verdict read back from the file, or a note explaining its absence.
   */
  async verify(request: VerifierRequest, signal: AbortSignal): Promise<VerifierOutcome> {
    const run = this.options.run ?? runProcess;
    const file = request.file;
    // Cancelled before anything happened: no session, no child, no verdict file.
    if (signal.aborted) return { type: 'cancelled' };
    await ensureDirectory(dirname(file));
    // A verdict left by an earlier run must never be read as this one's.
    await removeFile(file);
    // "Do not modify the artifact" is an instruction until it can be checked: fingerprint it when
    // the workspace this request declares is readable from here, and let a changed artifact void the
    // verdict. Which file that is comes from the request, never from this process's own directory.
    const artifactPath = request.artifact === undefined ? undefined : join(request.workspace, request.artifact);
    const before = artifactPath === undefined ? undefined : await fingerprint(artifactPath);

    const controller = new AbortController();
    let sessionId: string | undefined;
    let cancelled = false;
    let timedOut = false;
    /** Settles when the host answered the cancel request, so the outcome can say if it was confirmed. */
    let confirmation: Promise<void> | undefined;
    let confirmed: boolean | undefined;
    // The host owns the turn, so a killed child proves nothing about it. Cancellation is therefore a
    // request with a short, bounded wait: local cleanup never blocks on a host that never answers.
    const requestCancel = (id: string): void => {
      const cancel = this.options.cancelSession;
      if (cancel === undefined || confirmation !== undefined) return;
      confirmation = Promise.resolve(cancel(id)).then(() => { confirmed = true; }, () => { confirmed = false; });
    };
    const stop = (): void => {
      if (sessionId !== undefined) requestCancel(sessionId);
      controller.abort();
    };
    const onAbort = (): void => { cancelled = true; stop(); };
    const onTimeout = (): void => { timedOut = true; stop(); };
    const timer = setTimeout(onTimeout, this.options.timeoutMs);
    // Registered before the session exists, so an abort during creation cannot slip past the listener.
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    /** How the remote cancellation ended, and whether the remote turn is known to be stopped.
     *
     * `stopped: false` is what forbids a retry: starting a second remote task while the first may
     * still be running doubles the cost and the side effects.
     */
    const cancelNote = async (): Promise<{ note: string; stopped: boolean }> => {
      if (confirmation === undefined) {
        return this.options.cancelSession === undefined
          ? { note: 'host cannot cancel', stopped: false }
          : { note: 'no verifier session to cancel', stopped: true };
      }
      const settled = await Promise.race([
        confirmation.then(() => true),
        new Promise<boolean>(resolve => { const wait = setTimeout(() => resolve(false), CANCEL_CONFIRM_MS); wait.unref(); }),
      ]);
      if (!settled) return { note: `remote cancel unconfirmed after ${CANCEL_CONFIRM_MS} ms`, stopped: false };
      return confirmed === true
        ? { note: 'remote cancel confirmed', stopped: true }
        : { note: 'remote cancel rejected', stopped: false };
    };

    try {
      const created = await this.options.createSession(request.title);
      if (created === undefined) return { type: 'unavailable', reason: 'could not create a verifier session' };
      sessionId = created;
      if (cancelled || timedOut) {
        // The abort or the deadline landed while the session was being created: cancel what was just
        // made and never spawn a child that would send a prompt nobody is waiting for.
        requestCancel(created);
        const { note, stopped } = await cancelNote();
        return cancelled
          ? { type: 'cancelled' }
          : { type: 'unavailable', reason: `verifier timed out after ${this.options.timeoutMs} ms · ${note}`, sessionId,
            ...(stopped ? {} : { retryable: false }) };
      }
      const [program, ...leading] = this.options.command;
      // A missing entry is a configuration error, not an outage: retrying cannot fix it.
      if (program === undefined) return { type: 'unavailable', reason: 'no client entry to fork', retryable: false };
      const args = [...leading,
        '--url', this.options.url,
        ...(this.options.authDir === undefined ? [] : ['--auth-dir', this.options.authDir]),
        '--session', created,
        '--prompt', request.prompt,
        // The child judges and this client owns the protocol file, so the verdict is written by the
        // child from its own reply rather than by the model choosing a path and opening a file.
        '--verdict', file, '--verdict-identity', request.verificationId,
        '--wait', '--headless', '--no-memory-log'];

      // The child reports an interaction it cannot answer on the line below; the same parser keeps
      // both sides of the contract together, and every other line is passed through untouched.
      let human: VerificationHumanRequest | undefined;
      // The child's output is kept only to classify why it failed: `stderrText` for the class, and the
      // last line for the operator who explicitly asked for text (`--trace-verbose`). Neither is
      // reported by default, because a reason reaches the progress line and the trace, and that log
      // may be pasted into a report.
      let stderrText = '';
      let lastLine = '';
      const onLine = (line: string, stream: 'stdout' | 'stderr'): void => {
        human ??= parseNeedsHumanLine(line);
        const trimmed = line.trim();
        if (trimmed !== '') {
          lastLine = trimmed;
          if (stream === 'stderr') stderrText = `${stderrText}${trimmed}\n`.slice(-VERIFIER_STDERR_LIMIT);
        }
        this.options.onLine(line, stream);
      };
      /** A missing or unusable verdict stated as facts, with the child's words only on request. */
      const reasonFor = (lead: string): string => {
        // What this client's own child said about the failure beats the keyword class: "no JSON in the
        // reply" and "no reply committed" are different faults with different next steps, and both used
        // to be reported as `stderrClass unknown`. A child that said nothing gets no class at all,
        // because "unknown" would be noise on the ordinary "exited without writing a file" case.
        const fault = childFault(stderrText);
        const base = fault !== undefined ? `${lead} · ${fault}`
          : stderrText === '' ? lead : `${lead} · stderrClass ${classifyVerifierOutput(stderrText)}`;
        return this.options.verbose === true && lastLine !== '' ? `${base} · ${sanitizeTraceText(lastLine)}` : base;
      };
      const exit = await run(program, args, {
        cwd: this.options.cwd, env: this.options.env, signal: controller.signal, onLine,
      });
      // A cancelled review decides nothing, and is not a verifier outage either.
      if (cancelled) return { type: 'cancelled' };
      // The child stopped because the host wants a human: cancel the turn it left waiting (bounded,
      // reported), and hand the request to the caller instead of retrying into the same block.
      if (human !== undefined) {
        requestCancel(created);
        await cancelNote();
        return { type: 'needs-human', request: human, sessionId };
      }
      // A task that ran out of time is abandoned: a file that appeared as it died must not decide
      // the attempt, or a killed verifier could still pass the round. When the host never confirmed
      // the cancel, a retry could overlap a turn that is still running, so it is not offered one.
      if (timedOut) {
        const { note, stopped } = await cancelNote();
        return { type: 'unavailable', reason: `verifier timed out after ${this.options.timeoutMs} ms · ${note}`, sessionId,
          ...(stopped ? {} : { retryable: false }) };
      }
      const text = await readText(file);
      if (text === undefined) {
        const why = exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `exit ${exit.code}`;
        return { type: 'unavailable', reason: reasonFor(`verifier wrote no verdict (${why})`), sessionId };
      }
      if (before !== undefined) {
        const after = artifactPath === undefined ? undefined : await fingerprint(artifactPath);
        // Which process wrote it is not knowable here, so the reason states the fact rather than an
        // attribution: the file this verdict is about is not the file that was judged.
        if (after !== before) {
          return { type: 'unavailable', sessionId,
            reason: `reviewed artifact changed during verification (${request.artifact} · ${before.slice(0, 8)} → ${after?.slice(0, 8) ?? 'unreadable'})` };
        }
      }
      const result = parseVerdict(text, { verificationId: request.verificationId,
        kind: request.kind, step: request.step, attempt: request.attempt });
      if (result === undefined) return { type: 'unavailable', reason: reasonFor('verifier verdict was unusable'), sessionId };
      return { type: 'verified', result, sessionId };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
