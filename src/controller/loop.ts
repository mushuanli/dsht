/** The generic scored agent loop: what any "run steps until they pass" command reuses.
 *
 * A protocol supplies the prompt text and the step count; this module supplies everything else —
 * the step/attempt state machine, the passing-score decision, and the reply parser. The controller
 * adds the I/O around it (sending, watching for the turn to end, cancellation), so a second review
 * command only writes a `LoopProtocol`.
 */
import type { LoopProgress } from '../contracts.ts';
import type { LoopOptions } from '../slash/index.ts';
import type { Message } from '../session/transcript.ts';

/** One protocol's fully resolved limits. */
export interface LoopLimits {
  from: number;
  to: number;
  score: number;
  tries: number;
}

/** What one loop run is: its label, its step count, and the prompts it sends. */
export interface LoopProtocol {
  /** Fence marker of the reply's result block, without the backticks, e.g. `dsht-loop`. */
  marker: string;
  /** `kind` the result block must declare, so one marker can serve several protocols. */
  kind: string;
  /** Label shown in the progress line, e.g. `Design review`. */
  title: string;
  /** Steps the protocol defines; `--to` defaults to this. */
  steps: number;
  /** Workspace file the rounds maintain, when there is one; verified for tampering when readable. */
  artifact?: string;
  /** Optional name of one step, shown in the progress line. */
  stepLabel?(step: number): string;
  /** Passing score used when the command omits `--score`; default 8. */
  defaultScore?: number;
  /** Attempts per step used when the command omits `--tries`; default 10. */
  defaultTries?: number;
  /** Opening prompt for one step and attempt. */
  brief(limits: LoopLimits, step: number, attempt: number): string;
  /** Prompt for a later attempt, once the protocol is already in context. */
  followUp(limits: LoopLimits, step: number, attempt: number): string;
  /** Prompt a forked verifier session receives for one finished round.
   *
   * A protocol that defines this delegates the verdict to an independent process and names the file
   * that process must write; the reply block stays as the fallback when no verdict arrives.
   * @param limits - Resolved run limits.
   * @param step - Step in flight.
   * @param attempt - Attempt in flight.
   * @param target - Where the verdict goes and the identity it must declare.
   * @param previous - What the previous attempt on this step concluded, when there was one.
   * @returns The verifier's prompt.
   */
  verify?(limits: LoopLimits, step: number, attempt: number, target: VerifyTarget, previous?: PriorVerdict): string;
}

/** Longest evidence line and finding kept from a verdict, so untrusted model output stays bounded. */
const MAX_EVIDENCE_CHARS = 600;
const MAX_FINDING_CHARS = 300;
const MAX_FINDINGS = 8;

/** Consecutive attempts on one step that may fail to improve the score before the run stops.
 *
 * One plateau can be verifier jitter, so it is tolerated; two in a row mean the retry is not
 * converging. Set to 1 to stop on the first non-improvement (which includes a strict decrease).
 */
const STALL_STREAK = 2;

/** What one reply's result block reported. */
export interface LoopResult {
  /** Completion score in 0–10; absent when the block omitted or malformed it. */
  score?: number;
  /** What the verifier called it; advisory only — the loop decides from `score` and `blocked`. */
  status?: 'done' | 'retry' | 'blocked';
  /** The verifier proved the task impossible; the only verdict that overrides the score. */
  blocked?: boolean;
  /** What the verifier still objects to, so the next attempt can answer it. */
  findings?: readonly string[];
  /** The basis it gave for the score, so a retry does not have to guess. */
  evidence?: string;
}

/** Where one round's verdict goes, and the identity that file must declare. */
export interface VerifyTarget {
  /** Absolute path the verdict must be written to. */
  file: string;
  /** Identity embedded in the verdict, checked before the round. */
  verificationId: string;
}

/** What the previous attempt on this step concluded, when there was one. */
export interface PriorVerdict {
  /** Step that attempt belonged to. */
  step: number;
  /** Attempt number it was. */
  attempt: number;
  /** Its verdict. */
  result: LoopResult;
}

/** What one consumed attempt decided. */
export type LoopStepResult =
  | { kind: 'continue'; prompt: string }
  | { kind: 'passed' }
  | { kind: 'exhausted' }
  | { kind: 'stalled' }
  | { kind: 'blocked' };

/** Apply a protocol's defaults and reject a range that cannot run.
 * @param protocol - Protocol being started.
 * @param options - Flags exactly as parsed, absent when the operator omitted them.
 * @returns The resolved limits, or undefined when `to < from`.
 */
export function resolveLoop(protocol: LoopProtocol, options: LoopOptions): LoopLimits | undefined {
  const from = options.from ?? 1;
  const to = options.to ?? protocol.steps;
  const score = options.score ?? protocol.defaultScore ?? 8;
  const tries = options.tries ?? protocol.defaultTries ?? 10;
  if (to < from) return undefined;
  return { from, to, score, tries };
}

/** Read the result out of the last block of one reply.
 *
 * The block must be in the assistant's text, not reasoning, and this takes the last one so a reply
 * that quotes its verifier still reports its own verdict. A missing, malformed or foreign block is
 * undefined; a valid block with no usable field is an empty result, which counts as a failed attempt.
 * @param text - One turn's assistant text.
 * @param protocol - Protocol whose marker and kind identify the block.
 * @returns The reported score and verdict, or undefined when the reply carries no valid block.
 */
export function parseLoopResult(text: string, protocol: Pick<LoopProtocol, 'marker' | 'kind'>): LoopResult | undefined {
  let body: string | undefined;
  const segments = text.split('```');
  // Fenced blocks are the odd-indexed segments: prose, block, prose, block, …
  for (let index = 1; index < segments.length; index += 2) {
    const segment = segments[index]!;
    const newline = segment.indexOf('\n');
    if ((newline === -1 ? segment : segment.slice(0, newline)).trim() !== protocol.marker) continue;
    body = newline === -1 ? '' : segment.slice(newline + 1);
  }
  if (body === undefined) return undefined;
  try {
    const parsed = JSON.parse(body.trim()) as { kind?: unknown };
    if (parsed.kind !== protocol.kind) return undefined;
    return readResultFields(parsed);
  } catch { return undefined; }
}

/** Validate the score and verdict of one decoded result object.
 *
 * Shared with the forked verifier's verdict file, so a score means the same thing however it
 * travelled: an out-of-range or unknown field is absent rather than a value the loop would trust.
 * @param parsed - Decoded object expected to carry `score` and `status`.
 * @returns The usable fields; an empty result when the object carried none.
 */
export function readResultFields(parsed: object): LoopResult {
  const fields = parsed as { score?: unknown; status?: unknown; blocked?: unknown; top_findings?: unknown; evidence?: unknown };
  const score = typeof fields.score === 'number' ? fields.score : Number(fields.score);
  const status = fields.status === 'done' || fields.status === 'retry' || fields.status === 'blocked' ? fields.status : undefined;
  const rawFindings = fields.top_findings;
  const findings = Array.isArray(rawFindings)
    ? rawFindings.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .slice(0, MAX_FINDINGS).map(item => item.slice(0, MAX_FINDING_CHARS))
    : [];
  const evidence = typeof fields.evidence === 'string' && fields.evidence.trim() !== ''
    ? fields.evidence.slice(0, MAX_EVIDENCE_CHARS) : undefined;
  // `blocked` is a fact about the task, so it is the one field that can override the score; the
  // model's own `status` is kept only as an explanation, never as the run's state.
  const blocked = fields.blocked === true || status === 'blocked';
  return {
    ...(Number.isFinite(score) && score >= 0 && score <= 10 ? { score } : {}),
    ...(status === undefined ? {} : { status }),
    ...(blocked ? { blocked: true } : {}),
    ...(findings.length === 0 ? {} : { findings }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

/** Assistant text of the turn that just finished: from the last user/context row to the end.
 * @param messages - Projected conversation messages.
 * @returns The assistant text, empty when the turn produced none.
 */
export function latestAssistantText(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'You' || message.role === 'Context') break;
    if (message.role === 'Assistant') parts.unshift(message.text);
  }
  return parts.join('\n');
}

/** One run of the loop: which step and attempt is in flight, and what happens next.
 *
 * No I/O: the controller sends the prompt this returns and feeds back the parsed score, which keeps
 * the state machine trivially testable and identical for every protocol.
 */
export class ScoredLoop {
  private step: number;
  private attempt = 1;
  private best = 0;
  private noProgress = 0;
  private phase: LoopProgress['phase'] = 'running';
  private awaiting = false;
  private noteText?: string;

  constructor(readonly sessionId: string, readonly protocol: LoopProtocol, private readonly limits: LoopLimits) {
    this.step = limits.from;
  }

  /** Snapshot the UI renders; the loop keeps the authoritative numbers. */
  get progress(): LoopProgress {
    const stepLabel = this.protocol.stepLabel?.(this.step);
    return { title: this.protocol.title, ...this.limits, step: this.step, attempt: this.attempt, best: this.best, phase: this.phase,
      ...(stepLabel === undefined ? {} : { stepLabel }),
      ...(this.noteText === undefined ? {} : { note: this.noteText }) };
  }

  /** Attach one line about the attempt just decided, shown until the next verdict replaces it.
   * @param text - Note to show, or an empty string to clear it.
   */
  note(text: string): void { this.noteText = text === '' ? undefined : text; }

  /** Whether the run may still send or settle an attempt. */
  get active(): boolean { return this.phase === 'running'; }

  /** Whether a prompt was sent and its reply is still outstanding. */
  get settled(): boolean { return this.awaiting; }

  /** The opening prompt; the caller sends it and then calls `sent()`. */
  start(): string { return this.protocol.brief(this.limits, this.step, this.attempt); }

  /** Record that the outstanding prompt reached the host. */
  sent(): void { this.awaiting = true; }

  /** Consume one finished attempt.
   * @param result - Parsed result, or undefined when the reply carried no usable block.
   * @returns What the loop does next.
   */
  settle(result: LoopResult | undefined): LoopStepResult {
    this.awaiting = false;
    // A verifier that proved the task impossible ends the run instead of burning the budget.
    // Either spelling ends the run: `blocked` is the fact, `status` the legacy way of saying it.
    if (result?.blocked === true || result?.status === 'blocked') { this.phase = 'blocked'; return { kind: 'blocked' }; }
    const score = result?.score;
    const previousBest = this.best;
    if (score !== undefined) {
      if (score > previousBest) this.noProgress = 0;
      else if (this.attempt > 1) this.noProgress += 1;
      this.best = Math.max(this.best, score);
    }
    if (score !== undefined && score >= this.limits.score) {
      if (this.step >= this.limits.to) { this.phase = 'passed'; return { kind: 'passed' }; }
      this.step += 1; this.attempt = 1; this.best = 0; this.noProgress = 0;
      return { kind: 'continue', prompt: this.protocol.followUp(this.limits, this.step, this.attempt) };
    }
    // Retries that keep not improving are not converging: spending the rest of the step's budget on
    // them only reaches the same conclusion later, so the run stops and says so.
    if (this.noProgress >= STALL_STREAK) { this.phase = 'stalled'; return { kind: 'stalled' }; }
    // A missing or low score is a failed attempt and costs one from the step's budget.
    this.attempt += 1;
    if (this.attempt > this.limits.tries) { this.phase = 'exhausted'; return { kind: 'exhausted' }; }
    return { kind: 'continue', prompt: this.protocol.followUp(this.limits, this.step, this.attempt) };
  }

  /** Stop the run; a cancelled run never sends again. */
  cancel(): void { this.phase = 'cancelled'; this.awaiting = false; }

  /** End the run because independent verification was impossible.
   *
   * Deliberately not a verdict: no attempt is consumed, so the run stops on an infrastructure
   * failure instead of pretending the reviewer produced nothing.
   */
  unavailable(): void { this.phase = 'unavailable'; this.awaiting = false; }
}
