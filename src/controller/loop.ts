/** The generic scored agent loop: what any "run steps until they pass" command reuses.
 *
 * A protocol supplies the prompt text and the step count; this module supplies everything else —
 * the step/attempt state machine, the passing-score decision, and the reply parser. The controller
 * adds the I/O around it (sending, watching for the turn to end, cancellation), so a second review
 * command only writes a `LoopProtocol`.
 */
import type { LoopActivity, LoopLimits, LoopProgress, LoopTerminalReason } from '../contracts.ts';
import type { LoopOptions } from '../slash/index.ts';
import type { Message } from '../session/transcript.ts';

/** One protocol's fully resolved limits, shared with the form that confirms them. */
export type { LoopLimits };

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
  /** Line that file must contain once one step is done, when the protocol requires one.
   *
   * The score is the verifier's judgement; whether the round's conclusion actually reached the
   * artifact is a fact this client checks, and a hard condition no score may override.
   */
  artifactMarker?(step: number): string | undefined;
  /** Optional name of one step, shown in the progress line. */
  stepLabel?(step: number): string;
  /** Passing score used when the command omits `--score`; default 8. */
  defaultScore?: number;
  /** Attempts per step used when the command omits `--tries`; default 10. */
  defaultTries?: number;
  /** Which phase a step starts in: verifying the existing artifact, or working on it.
   *
   * A review of something that already exists starts by verifying it, so a step that passes costs
   * no work turn; anything else starts by asking for the work. Defaults to `work`.
   */
  starts?: 'verify' | 'work';
  /** Opening prompt for one step and attempt. */
  brief(limits: LoopLimits, step: number, attempt: number): string;
  /** Prompt for a later attempt, once the protocol is already in context. */
  followUp(limits: LoopLimits, step: number, attempt: number): string;
  /** Prompt a forked verifier session receives for one finished round.
   *
   * A protocol that defines this delegates the verdict to an independent process and names the file
   * that process must write. Independent verification is the only scorer: a reply block is never
   * used to override its absence, so an outage stops the run instead of passing it.
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
/** Longest reason a verifier may give for stopping early. */
const MAX_REASON_CHARS = 300;

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
  /** What the verifier called it; advisory only — the loop decides from `score`, `blocked` and `abstained`. */
  status?: 'done' | 'retry' | 'blocked' | 'abstained';
  /** The verifier proved the task impossible at any score; the one field that overrides `score`. */
  blocked?: boolean;
  /** The verifier cannot judge and needs a person; ends the run without a score. */
  abstained?: boolean;
  /** Why it stopped, when it stopped before the budget: `cannot-fix` or `needs-human`. */
  exitReason?: 'cannot-fix' | 'needs-human';
  /** That reason in one line a reader can act on; required by an `exitReason`. */
  reason?: string;
  /** One line a person must supply, when the verifier asked for one. */
  needs?: string;
  /** Advisory note that never changes control: "nothing to change here", "already covered", … */
  explanation?: string;
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
  | { kind: 'blocked' }
  | { kind: 'needs-human' };

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

/** Whether a run's rounds cover the whole record rather than a selected range.
 *
 * Only this case may report more than "the rounds that ran passed": the last round is then the
 * record's consolidation round, and the verifier is handed every earlier round to re-check.
 * @param from - First step of the run.
 * @param to - Last step of the run.
 * @param steps - Steps the protocol defines.
 * @returns True when the run starts at the first round and ends at the last one.
 */
export function coversWholeProtocol(from: number, to: number, steps: number): boolean {
  return from === 1 && to === steps;
}

/** How to describe the rounds a finished run covered.
 *
 * `passed` only ever claims the rounds that ran, so the snapshot carries this phrase and every place
 * that reports a pass says it too: a pass over the whole record and a pass over a selected range
 * must not read the same.
 * @param progress - Run limits and the protocol's total round count.
 * @returns One phrase, e.g. `rounds 1–10/10` or `rounds 1–3/10 · selected range`.
 */
function loopScope(progress: LoopLimits & { total: number }): string {
  const { from, to, total } = progress;
  const label = from === to ? `round ${from}/${total}` : `rounds ${from}–${to}/${total}`;
  return coversWholeProtocol(from, to, total) ? label : `${label} · selected range`;
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
 * @returns The usable fields; an empty result when the object carried none, and `undefined` when it
 *   claimed an early stop that breaks the rules — such a claim is not a verdict at all, so the
 *   caller reports verification as unusable instead of guessing what was meant.
 */
export function readResultFields(parsed: object): LoopResult | undefined {
  const fields = parsed as { score?: unknown; status?: unknown; blocked?: unknown; top_findings?: unknown; evidence?: unknown;
    exit_reason?: unknown; reason?: unknown; needs?: unknown; explanation?: unknown };
  const score = typeof fields.score === 'number' ? fields.score : Number(fields.score);
  const status = fields.status === 'done' || fields.status === 'retry' || fields.status === 'blocked' || fields.status === 'abstained'
    ? fields.status : undefined;
  const rawFindings = fields.top_findings;
  const findings = Array.isArray(rawFindings)
    ? rawFindings.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .slice(0, MAX_FINDINGS).map(item => item.slice(0, MAX_FINDING_CHARS))
    : [];
  const text = (value: unknown, limit: number): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.slice(0, limit) : undefined;
  const evidence = text(fields.evidence, MAX_EVIDENCE_CHARS);
  const reason = text(fields.reason, MAX_REASON_CHARS);
  const needs = text(fields.needs, MAX_REASON_CHARS);
  // An advisory line that never changes control: "nothing to change here" is an explanation, not a
  // shortcut past the rounds that have not run yet.
  const explanation = text(fields.explanation, MAX_EVIDENCE_CHARS);
  const hasScore = Number.isFinite(score) && score >= 0 && score <= 10;
  // `blocked` is a fact about the task, so it is the one field that can override the score; the
  // model's own `status` is kept only as an explanation, never as the run's state.
  const blocked = fields.blocked === true || status === 'blocked';
  const abstained = status === 'abstained';
  const base: LoopResult = {
    ...(hasScore ? { score } : {}),
    ...(status === undefined ? {} : { status }),
    ...(explanation === undefined ? {} : { explanation }),
    ...(findings.length === 0 ? {} : { findings }),
    ...(evidence === undefined ? {} : { evidence }),
  };
  // An early stop is a claim about the task, so it is validated as a whole and never partially
  // honored: exactly one of "proved impossible" and "cannot judge", a reason a reader can act on,
  // no score for `abstained` to hide behind, and an `exit_reason` label that agrees with the flags.
  const claims = blocked || abstained || fields.exit_reason !== undefined;
  if (!claims) return base;
  if (reason === undefined || blocked === abstained || hasScore) return undefined;
  const exitReason: NonNullable<LoopResult['exitReason']> = abstained ? 'needs-human' : 'cannot-fix';
  if (fields.exit_reason !== undefined && fields.exit_reason !== exitReason) return undefined;
  return { ...base, ...(blocked ? { blocked: true } : {}), ...(abstained ? { abstained: true } : {}),
    exitReason, reason, ...(abstained && needs !== undefined ? { needs } : {}) };
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
  /** What the live run is waiting on; only the controller's own sends and verdicts set it. */
  private activity?: LoopActivity;
  /** Why the run stopped; set once, together with a terminal phase. */
  private terminalReason?: LoopTerminalReason;
  private noteText?: string;
  private interaction?: { kind: string; text: string; needs?: string };
  private exit?: { reason: string };
  /** When this run began, so a reader can clock it even while no host turn is running. */
  private readonly startedAt = Date.now();

  constructor(readonly runId: string, readonly sessionId: string, readonly protocol: LoopProtocol, private readonly limits: LoopLimits) {
    this.step = limits.from;
  }

  /** Snapshot the UI renders; the loop keeps the authoritative numbers. */
  get progress(): LoopProgress {
    const stepLabel = this.protocol.stepLabel?.(this.step);
    return { runId: this.runId, title: this.protocol.title, startedAt: this.startedAt, ...this.limits, total: this.protocol.steps, scope: loopScope({ ...this.limits, total: this.protocol.steps }),
      step: this.step, attempt: this.attempt, best: this.best, phase: this.phase, active: this.active,
      // Activity describes a run that is still going: a terminal phase has nothing left to wait for.
      ...(this.phase !== 'running' || this.activity === undefined ? {} : { activity: this.activity }),
      ...(this.terminalReason === undefined ? {} : { terminalReason: this.terminalReason }),
      ...(stepLabel === undefined ? {} : { stepLabel }),
      ...(this.noteText === undefined ? {} : { note: this.noteText }),
      ...(this.interaction === undefined ? {} : { interaction: this.interaction }),
      ...(this.exit === undefined ? {} : { exit: this.exit }) };
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
  sent(): void { this.awaiting = true; this.activity = 'turn'; }

  /** Record that this attempt is judged by a forked verifier instead of the session's own turn. */
  verifying(): void { this.awaiting = true; this.activity = 'verify'; }

  /** Record that the turn ended and its result is being read, which is neither work nor a verdict. */
  settling(): void { this.activity = 'settle'; }

  /** Consume one finished attempt.
   * @param result - Parsed result, or undefined when the reply carried no usable block.
   * @returns What the loop does next.
   */
  settle(result: LoopResult | undefined): LoopStepResult {
    this.awaiting = false;
    this.activity = 'settle';
    // A verifier that cannot judge asks for a person. Phase 1 has no answer path, so the request is
    // carried on the progress and the run stops instead of spending the attempt budget on it.
    if (result?.abstained === true) {
      this.phase = 'needs-human';
      this.terminalReason = 'verifier-needs-human';
      this.interaction = { kind: 'verdict', text: result.reason ?? 'the verifier needs a person',
        ...(result.needs === undefined ? {} : { needs: result.needs }) };
      return { kind: 'needs-human' };
    }
    // A verifier that proved the task impossible ends the run instead of burning the budget.
    // Either spelling ends the run: `blocked` is the fact, `status` the legacy way of saying it.
    if (result?.blocked === true || result?.status === 'blocked') {
      this.phase = 'blocked';
      this.terminalReason = 'blocked';
      if (result.reason !== undefined) this.exit = { reason: result.reason };
      return { kind: 'blocked' };
    }
    const score = result?.score;
    const previousBest = this.best;
    if (score !== undefined) {
      if (score > previousBest) this.noProgress = 0;
      else if (this.attempt > 1) this.noProgress += 1;
      this.best = Math.max(this.best, score);
    }
    if (score !== undefined && score >= this.limits.score) {
      if (this.step >= this.limits.to) { this.phase = 'passed'; this.terminalReason = 'pass'; return { kind: 'passed' }; }
      this.step += 1; this.attempt = 1; this.best = 0; this.noProgress = 0;
      return { kind: 'continue', prompt: this.protocol.followUp(this.limits, this.step, this.attempt) };
    }
    // Retries that keep not improving are not converging: spending the rest of the step's budget on
    // them only reaches the same conclusion later, so the run stops and says so.
    if (this.noProgress >= STALL_STREAK) { this.phase = 'stalled'; this.terminalReason = 'stalled'; return { kind: 'stalled' }; }
    // A missing or low score is a failed attempt and costs one from the step's budget.
    this.attempt += 1;
    if (this.attempt > this.limits.tries) { this.phase = 'exhausted'; this.terminalReason = 'exhausted'; return { kind: 'exhausted' }; }
    return { kind: 'continue', prompt: this.protocol.followUp(this.limits, this.step, this.attempt) };
  }

  /** Stop the run; a cancelled run never sends again.
   * @param reason - Who ended it, so a cancellation is not confused with a verdict.
   */
  cancel(reason: LoopTerminalReason = 'user-cancelled'): void {
    this.phase = 'cancelled'; this.awaiting = false; this.terminalReason = reason;
  }

  /** End the run because independent verification was impossible.
   *
   * Deliberately not a verdict: no attempt is consumed, so the run stops on an infrastructure
   * failure instead of pretending the reviewer produced nothing.
   * @param reason - Which verification failure ended it.
   */
  unavailable(reason: LoopTerminalReason = 'verifier-unavailable'): void {
    this.phase = 'unavailable'; this.awaiting = false; this.terminalReason = reason;
  }

  /** End the run because the whole-run deadline expired.
   *
   * A budget stop, not a verdict: it bounds the sum of all steps, attempts and verifier retries, so
   * no attempt is consumed and `best` is untouched.
   */
  deadline(): void { this.phase = 'deadline'; this.awaiting = false; this.terminalReason = 'deadline'; }

  /** Stop because a human is needed, whether a verdict abstained or the host is blocked.
   *
   * Phase 1 has no answer path (`/loop answer` is future work), so this ends the run with the
   * request attached: spending the attempt budget on a blocked verifier helps nobody. No attempt is
   * consumed and `best` is untouched.
   * @param request - The approval or question the host is waiting for, or a verdict's request.
   * @param reason - Which kind of human request this is.
   */
  human(request: { kind: string; text: string }, reason: LoopTerminalReason = 'verifier-needs-human'): void {
    this.phase = 'needs-human';
    this.awaiting = false;
    this.terminalReason = reason;
    this.interaction = request;
  }
}
