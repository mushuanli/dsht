/** Independent verification of one scored round, as a capability rather than a mechanism.
 *
 * The loop owns when a round is judged; this port owns how. The implementation runs a child `dsht`
 * against a session of its own and reads the verdict file that session writes, but the controller
 * only ever sees a port, so a test can decide a round without spawning anything.
 */
import { join } from 'node:path';
import type { LoopResult } from './loop.ts';

/** Identity one verification carries, so a file can never be read as another run's verdict.
 *
 * Two clients reviewing the same step would otherwise write and delete the same path, and the
 * kind/step/attempt triple cannot tell them apart. The sequence is the finer half: one `attempt`
 * may start several verification tasks (a failure retry, an operator answer), and only the task
 * that is still awaited may decide the attempt.
 * @param runId - Identity of one loop run, unique per client run.
 * @param kind - Protocol kind.
 * @param step - Step in flight.
 * @param attempt - Attempt in flight.
 * @param seq - This verification task's sequence within the run.
 * @returns The identity string embedded in the verdict file.
 */
export function verificationId(runId: string, kind: string, step: number, attempt: number, seq: number): string {
  return `${runId}/${kind}/${step}/${attempt}/${seq}`;
}

/** Directory holding one run's verdicts, so a whole review can be audited or removed as a group.
 * @param directory - Workspace directory the review runs in.
 * @param runId - Identity of the run.
 * @returns The absolute directory.
 */
export function verdictDirectory(directory: string, runId: string): string {
  return join(directory, '.dsht', 'verify', runId);
}

/** Path of the verdict one verification task must write.
 * @param directory - Workspace directory the review runs in.
 * @param runId - Identity of the run; part of the path so concurrent runs never collide.
 * @param kind - Protocol kind.
 * @param step - Step in flight.
 * @param attempt - Attempt in flight.
 * @param seq - This verification task's sequence within the run; part of the name so a retry
 *   cannot be read as, or overwrite, the task it replaced.
 * @returns The absolute verdict path.
 */
export function verdictFile(directory: string, runId: string, kind: string, step: number, attempt: number, seq: number): string {
  return join(verdictDirectory(directory, runId), `${kind}-${step}-${attempt}-${seq}.json`);
}

/** One round handed to an independent verifier. */
export interface VerifierRequest {
  /** Identity of this verification; the verdict file must declare it back. */
  verificationId: string;
  /** Protocol kind the verdict must declare, so a stale file cannot score this round. */
  kind: string;
  /** Step in flight. */
  step: number;
  /** Attempt in flight. */
  attempt: number;
  /** Prompt the verifier session receives, built by the protocol. */
  prompt: string;
  /** Session title, so a reader can tell verifier sessions apart in the host's list. */
  title: string;
  /** Absolute path the verifier must write its verdict to. */
  file: string;
  /** Absolute path of the workspace the artifact belongs to.
   *
   * Declared per request instead of inferred from the verifier's own working directory: the
   * reviewed tree and the process that happens to run the check are different things, and only the
   * caller knows which workspace this round is about.
   */
  workspace: string;
  /** Workspace file the verifier must not change, when the protocol names one. */
  artifact?: string;
}

/** What a host is waiting for when the verifier cannot answer by itself. */
export interface VerificationHumanRequest {
  /** `approval` or `question`, as the host reported it. */
  kind: string;
  /** One line a reader can act on. */
  text: string;
}

/** Marker a child prints on the line that reports an unanswerable human request.
 *
 * The child sees the interaction on its own session and exits; the parent parses the same line back
 * out of the child's output. One definition keeps both sides from drifting.
 */
export const NEEDS_HUMAN_MARKER = 'dsht-verify-needs-human:';

/** Render the line the child logs and the parent parses.
 * @param request - What the host is waiting for.
 * @returns The marker line.
 */
export function needsHumanLine(request: VerificationHumanRequest): string {
  return `${NEEDS_HUMAN_MARKER}${JSON.stringify(request)}`;
}

/** Read that line back, ignoring every other line the child prints.
 * @param line - One child output line.
 * @returns The request, or undefined when the line is not this marker.
 */
export function parseNeedsHumanLine(line: string): VerificationHumanRequest | undefined {
  const at = line.indexOf(NEEDS_HUMAN_MARKER);
  if (at === -1) return undefined;
  try {
    const parsed = JSON.parse(line.slice(at + NEEDS_HUMAN_MARKER.length)) as { kind?: unknown; text?: unknown };
    if (typeof parsed.kind !== 'string' || typeof parsed.text !== 'string') return undefined;
    return { kind: parsed.kind, text: parsed.text };
  } catch { return undefined; }
}

/** What one verification produced.
 *
 * A missing verdict is not a failed review: the reviewed session produced work and nobody judged it.
 * The two are kept apart so an outage never spends an attempt and never lets the reviewer pass itself.
 */
export type VerifierOutcome =
  /** An independent verdict was produced and can decide the attempt. */
  | { type: 'verified'; result: LoopResult; sessionId: string }
  /** The verifier could not judge: no session, no child, no verdict, or a timeout.
   *
   * `retryable: false` means the same failure will not fix itself — a remote task may still be
   * running, or the client is configured wrong — so the controller reports it instead of spending
   * its retry budget. Absent means the failure is treated as transient.
   */
  | { type: 'unavailable'; reason: string; sessionId?: string; retryable?: boolean }
  /** The review itself was cancelled, so there is nothing to decide. */
  | { type: 'cancelled' }
  /** The host is waiting for a human; the verifier session's turn was cancelled, not judged. */
  | { type: 'needs-human'; request: VerificationHumanRequest; sessionId: string };

/** Judge one round independently. */
export interface VerifierPort {
  /** Which harness judges: `dsht` for the forked client, a future adapter names itself here. */
  readonly name: string;
  /** Run one verification to completion, or to cancellation.
   * @param request - Round identity, prompt and verdict path.
   * @param signal - Cancels the run and its child process.
   * @returns The verdict, or a note explaining why there is none.
   */
  verify(request: VerifierRequest, signal: AbortSignal): Promise<VerifierOutcome>;
  /** Drain adapter-owned cleanup after all run signals have been aborted, before closing the host.
   * Adapters with child processes or remote sessions implement this; pure in-memory judges need not.
   */
  settle?(): Promise<void>;
}
