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
 * kind/step/attempt triple cannot tell them apart.
 * @param runId - Identity of one loop run, unique per client run.
 * @param kind - Protocol kind.
 * @param step - Step in flight.
 * @param attempt - Attempt in flight.
 * @returns The identity string embedded in the verdict file.
 */
export function verificationId(runId: string, kind: string, step: number, attempt: number): string {
  return `${runId}/${kind}/${step}/${attempt}`;
}

/** Directory holding one run's verdicts, so a whole review can be audited or removed as a group.
 * @param directory - Workspace directory the review runs in.
 * @param runId - Identity of the run.
 * @returns The absolute directory.
 */
export function verdictDirectory(directory: string, runId: string): string {
  return join(directory, '.dsht', 'verify', runId);
}

/** Path of the verdict one round must write.
 * @param directory - Workspace directory the review runs in.
 * @param runId - Identity of the run; part of the path so concurrent runs never collide.
 * @param kind - Protocol kind.
 * @param step - Step in flight.
 * @param attempt - Attempt in flight.
 * @returns The absolute verdict path.
 */
export function verdictFile(directory: string, runId: string, kind: string, step: number, attempt: number): string {
  return join(verdictDirectory(directory, runId), `${kind}-${step}-${attempt}.json`);
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
  /** Workspace file the verifier must not change, when the protocol names one. */
  artifact?: string;
}

/** What one verification produced.
 *
 * A missing verdict is not a failed review: the reviewed session produced work and nobody judged it.
 * The two are kept apart so an outage never spends an attempt and never lets the reviewer pass itself.
 */
export type VerifierOutcome =
  /** An independent verdict was produced and can decide the attempt. */
  | { type: 'verified'; result: LoopResult; sessionId: string }
  /** The verifier could not judge: no session, no child, no verdict, or a timeout. */
  | { type: 'unavailable'; reason: string; sessionId?: string }
  /** The review itself was cancelled, so there is nothing to decide. */
  | { type: 'cancelled' };

/** Judge one round independently. */
export interface VerifierPort {
  /** Run one verification to completion, or to cancellation.
   * @param request - Round identity, prompt and verdict path.
   * @param signal - Cancels the run and its child process.
   * @returns The verdict, or a note explaining why there is none.
   */
  verify(request: VerifierRequest, signal: AbortSignal): Promise<VerifierOutcome>;
}
