/** Coordinates scored runs; each execution owns its own timers and asynchronous continuations. */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listEntries, readText } from '../storage/index.ts';
import { errorText } from '../text.ts';
import type { ObjectValue } from '../json.ts';
import type { LoopProgress, LoopTerminalReason } from '../contracts.ts';
import { parseLoopResult, ScoredLoop, type LoopLimits, type LoopProtocol, type LoopResult, type PriorVerdict } from './loop.ts';
import { findingsLines } from './loop-contract.ts';
import { verificationId, verdictFile, type VerifierOutcome, type VerifierPort } from './verifier.ts';

const VERIFIER_RETRIES = 2;
/** Grace for the assistant reply that may commit just after the host's idle frame. */
const LOOP_SETTLE_GRACE_MS = 4000;

/** Application facts and effects a loop needs; no Controller, State or Transcript crosses here. */
export interface LoopHost {
  facts(): { sessionId?: string; online: boolean; busy: boolean; pending: boolean; ready: boolean };
  reply(): string;
  send(prompt: string): Promise<void>;
  publish(failure?: string): void;
  trace(event: string, detail: ObjectValue): void;
}

export interface LoopCoordinatorOptions {
  directory: string;
  verifier?: VerifierPort;
  verdictRoot?: string;
  deadlineMs?: number;
  allowSelfFallback?: boolean;
}

/** Owns the selected run and its lifetime, while ScoredLoop owns the pure scoring rules. */
export class LoopCoordinator {
  private current?: LoopExecution;
  private closed = false;
  constructor(private readonly host: LoopHost, private readonly options: LoopCoordinatorOptions) {}

  get progress(): LoopProgress | undefined { return this.current?.progress; }
  get sessionId(): string | undefined { return this.current?.sessionId; }
  get verifierName(): string | undefined { return this.options.verifier?.name; }
  get forkedVerification(): boolean { return this.options.verifier !== undefined; }
  get selfScoring(): boolean { return !this.forkedVerification || this.options.allowSelfFallback === true; }

  async start(protocol: LoopProtocol, limits: LoopLimits): Promise<void> {
    if (this.closed) throw new Error('Client stopped');
    const sessionId = this.host.facts().sessionId;
    if (sessionId === undefined) {
      this.host.trace('loop', { phase: 'refused', kind: protocol.kind, reason: 'no-session' });
      throw new Error('Select a session first');
    }
    this.forget();
    const run: LoopExecution = new LoopExecution(this.host, this.options, () => this.current === run && !this.closed);
    this.current = run;
    await run.startLoop(sessionId, protocol, limits);
  }

  stop(reason: LoopTerminalReason = 'user-cancelled'): void { this.current?.stopLoop(reason); }
  answer(text: string): Promise<void> {
    if (this.closed || this.current === undefined) return Promise.reject(new Error('No loop is waiting for an answer'));
    return this.current.answerLoop(text);
  }
  clearResult(): void {
    if (this.current === undefined || this.progress?.active) return;
    this.forget();
    this.host.publish();
  }
  forget(): void {
    const previous = this.current;
    this.current = undefined;
    previous?.forgetLoop();
  }
  /** Called after application facts or transcript content change. */
  changed(): void { if (!this.closed) this.current?.changed(); }
  idle(sessionId: string): void { if (!this.closed) this.current?.settleLoop(sessionId); }
  /** Stop timers and verifier work before the application tears down the connection. */
  async close(): Promise<void> {
    this.closed = true;
    this.current?.stopLoop();
    await this.options.verifier?.settle?.();
  }
}

/** Never reused for another run: a late callback can only touch the execution that created it. */
class LoopExecution {
  /** Running agent loop, if any; the loop lives here, not in the UI. */
  private loop?: ScoredLoop;
  /** Prompt the loop still has to send, when it could not be sent immediately. */
  private pendingPrompt?: string;
  /** When the in-flight attempt's turn ended, while its result block is still awaited. */
  private endedAt?: number;
  /** Timer that settles an attempt whose reply never commits its result block. */
  private settleTimer?: NodeJS.Timeout;
  /** Whether an attempt is currently being judged by an independent verifier. */
  private verifying = false;
  /** A verdict is being consumed right now.
   *
   * Consuming one reads the artifact, so it is asynchronous; without this gate a replayed idle edge
   * could start a second verification of an attempt whose verdict is already being applied.
   */
  private settling = false;
  /** Cancels that verification when the loop is stopped or replaced. */
  private verifyAbort?: AbortController;
  /** Verdict of the previous attempt on the current step, for the retry and the next verifier. */
  private previous?: PriorVerdict;
  /** Whether the run in flight already wrote its `loop end`; one end per begin (I9). */
  private endTraced = false;
  /** Sequence of the verification task in flight, so a retry never reuses the old task's identity. */
  private verificationSeq = 0;
  /** Identity of the verification task whose result may still decide the attempt in flight. */
  private verificationIdentity?: string;
  /** Timer that stops the whole run when its budget expires. */
  private deadlineTimer?: NodeJS.Timeout;
  /** Whole-run budget, when the operator set one. */
  private readonly deadlineMs?: number;
  /** Consecutive verifier outages in this attempt, so a broken verifier is retried then reported. */
  private verifierMisses = 0;
  /** What the operator answered when a verifier abstained; consumed by the next judgment. */
  private answerText?: string;
  /** Whether a reply block may stand in for a missing verdict; off unless asked for. */
  private readonly allowSelfFallback: boolean;
  /** Client-side directory verdict files are written under. */
  private readonly verdictRoot: string;
  private readonly verifier?: VerifierPort;
  private readonly localDirectory: string;

  constructor(private readonly host: LoopHost, options: LoopCoordinatorOptions, private readonly owns: () => boolean) {
    this.verifier = options.verifier;
    this.localDirectory = options.directory;
    this.verdictRoot = options.verdictRoot ?? options.directory;
    this.deadlineMs = options.deadlineMs;
    this.allowSelfFallback = options.allowSelfFallback === true;
  }

  get progress(): LoopProgress | undefined { return this.loop?.progress; }
  get sessionId(): string | undefined { return this.loop?.sessionId; }

  changed(): void {
    if (this.pendingPrompt !== undefined) void this.flushLoop();
    if (this.endedAt !== undefined) this.trySettleLoop();
  }

  private update(patch: { lastFailure?: string }): void {
    if (this.owns()) this.host.publish(patch.lastFailure);
  }
  private isCurrent(loop: ScoredLoop): boolean { return this.owns() && this.loop === loop && loop.active; }
  private traceEvent(event: string, detail: ObjectValue): void { this.host.trace(event, detail); }

  /** Start a scored loop and send its opening step.
   * @param protocol - Prompt text and step count the loop follows.
   * @param limits - Resolved `--from/--to/--score/--tries`.
   */
  async startLoop(sessionId: string, protocol: LoopProtocol, limits: LoopLimits): Promise<void> {
    const runId = randomUUID();
    this.endTraced = false;
    this.traceEvent('loop', { phase: 'begin', runId, kind: protocol.kind, session: sessionId,
      from: limits.from, to: limits.to, score: limits.score, tries: limits.tries, forked: this.verifier !== undefined });
    const loop = new ScoredLoop(runId, sessionId, protocol, limits);
    this.loop = loop;
    // A protocol that reviews something already on disk verifies first: a round that passes costs no
    // work turn at all, and only a failing verdict asks the agent to change anything.
    if (this.startsByVerifying(loop)) {
      this.armLoopDeadline();
      this.update({});
      this.traceEvent('loop', { phase: 'verify-first', runId, kind: protocol.kind, step: limits.from });
      this.verifyStep(loop);
      return;
    }
    const prompt = loop.start();
    loop.sent();
    this.armLoopDeadline();
    this.update({});
    try {
      if (!this.isCurrent(loop)) return;
      await this.host.send(prompt);
      this.traceEvent('loop', { phase: 'sent', runId, kind: protocol.kind, step: limits.from, attempt: 1 });
    } catch (error) {
      // The run never got its first turn. It ends needing a person rather than silently vanishing:
      // the reason says the send was rejected, and the snapshot stays readable.
      this.rejectLoopSend(loop, error);
      throw error;
    }
  }

  /** End a run whose next prompt could not be sent, keeping the reason visible.
   *
   * A rejected send is not a verdict and not an operator cancellation, so the phase is `needs-human`
   * and `terminalReason` says why — this is what keeps `phase=cancelled` meaning "a person stopped it".
   * @param loop - Run that could not send.
   * @param error - What the host or the session layer rejected with.
   */
  private rejectLoopSend(loop: ScoredLoop, error: unknown): void {
    if (!this.isCurrent(loop)) return;
    const text = errorText(error).slice(0, 200);
    this.forgetSettleTimer();
    this.clearLoopDeadline();
    this.abortVerification();
    loop.human({ kind: 'send', text }, 'send-rejected');
    this.traceLoopEnd(loop);
    this.pendingPrompt = undefined;
    this.update({ lastFailure: text });
  }

  /** Record the end of one run once, with the phase it stopped in and why.
   *
   * I9 needs every `begin` to be paired inside the trace window; this is the only writer of `loop end`.
   * @param loop - Run whose terminal phase was just published.
   */
  private traceLoopEnd(loop: ScoredLoop): void {
    if (this.endTraced) return;
    this.endTraced = true;
    const progress = loop.progress;
    this.traceEvent('loop', { phase: 'end', runId: progress.runId, kind: loop.protocol.kind,
      result: progress.phase, step: progress.step, attempt: progress.attempt,
      reason: progress.terminalReason ?? 'unknown' });
  }

  /** Whether a step begins with verification rather than with a work prompt.
   *
   * Needs all three: the record asks for it, the record has a verifier prompt, and this client was
   * given a verifier. Otherwise there is nobody to verify first, and the step asks for work.
   * @param loop - Loop about to start a step.
   * @returns True when the step starts by verifying.
   */
  private startsByVerifying(loop: ScoredLoop): boolean {
    return loop.protocol.starts === 'verify' && loop.protocol.verify !== undefined && this.verifier !== undefined;
  }

  /** Verify the step in flight without a work turn before it.
   *
   * The activity is set inside `verifyRound`, so the first verification, a work-turn verdict and a
   * retry all publish the same state without this caller having to remember it.
   * @param loop - Loop whose step and attempt are already set.
   */
  private verifyStep(loop: ScoredLoop): void {
    void this.verifySection(loop);
  }

  /** Check the round's own section before spending a verifier on it, then verify or ask for work.
   *
   * Verify-first exists so a round that already passes costs no work turn. When the section is not in
   * the artifact at all the round *cannot* pass, and this client can read that itself — the same check
   * it applies to a verdict before accepting one. Sending a verifier to discover "the file is missing"
   * costs a session and, because a failed attempt consumes one, also the round's first attempt: a run
   * over a document with no review yet would start working at attempt 2/10. An artifact this client
   * cannot read stays a boundary: the verification runs and its verdict decides, as before.
   * @param loop - Loop whose step and attempt are already set.
   */
  private async verifySection(loop: ScoredLoop): Promise<void> {
    if (!this.isCurrent(loop)) return;
    const artifact = loop.protocol.artifact;
    const marker = loop.protocol.artifactMarker?.(loop.progress.step);
    if (artifact === undefined || marker === undefined) { void this.verifyRound(loop); return; }
    // `readText` answers undefined only for a file that is not there and throws for one that cannot be
    // read, so the two cases are told apart here: a missing file has no section either, while an
    // unreadable one is a boundary this client cannot decide.
    let text: string | undefined;
    try { text = await readText(join(this.localDirectory, artifact)); }
    catch { void this.verifyRound(loop); return; }
    // Reading the artifact is I/O, so the run may have moved on before it came back.
    if (!this.isCurrent(loop)) return;
    if (text !== undefined && text.includes(marker)) { void this.verifyRound(loop); return; }
    // A missing file only proves the producer never wrote it when this client can see the workspace at
    // all. A workspace this machine does not have is a boundary — the same boundary the artifact check
    // after a verdict already respects — so the verifier's reading decides instead.
    const visible = text !== undefined || await this.workspaceVisible();
    if (!this.isCurrent(loop)) return;
    if (!visible) { void this.verifyRound(loop); return; }
    this.traceEvent('loop', { phase: 'work-first', runId: loop.runId, kind: loop.protocol.kind,
      step: loop.progress.step, artifact, reason: 'section-missing' });
    loop.note(`⚠ artifact check · ${artifact} 还没有本轮小节，直接开始工作`);
    // No verdict was consumed, so the attempt is untouched: the first work turn is attempt 1, exactly
    // as it is for a record that asks for work first.
    this.pendingPrompt = loop.workPrompt();
    this.update({});
    void this.flushLoop();
  }

  /** Whether the directory this client runs in is readable here at all.
   *
   * `readText` answers undefined for a missing file and for a file inside a directory this machine does
   * not have, and the two mean opposite things: the first is a producer that wrote nothing, the second
   * is a workspace whose verdict cannot be checked from here.
   * @returns True when the directory can be listed.
   */
  private async workspaceVisible(): Promise<boolean> {
    try { await listEntries(this.localDirectory); return true; }
    catch { return false; }
  }

  /** Arm the whole-run budget, when the operator set one. */
  private armLoopDeadline(): void {
    if (this.deadlineMs === undefined) return;
    this.deadlineTimer = setTimeout(() => this.expireLoopDeadline(), this.deadlineMs);
    this.deadlineTimer.unref();
  }

  /** Answer a paused run, so the current artifact is judged again with what the operator supplied.
   *
   * The answer is not a work order: it only adds a condition to the judgment, so nothing is sent to the
   * agent and no attempt is consumed. The verification that follows is a new task with a new identity,
   * which is what keeps a late verdict from the paused one from deciding the attempt.
   * @param text - What the operator added; never written to the trace.
   */
  async answerLoop(text: string): Promise<void> {
    const loop = this.loop;
    if (loop === undefined || !loop.active) throw new Error('No loop is waiting for an answer');
    this.answerText = text;
    const judged = this.verifier !== undefined && loop.protocol.verify !== undefined;
    loop.resume(judged ? 'verify' : 'turn');
    this.update({});
    this.traceEvent('loop', { phase: 'answered', runId: loop.progress.runId, judged, chars: text.length });
    if (judged) { this.verifyStep(loop); return; }
    // Without a forked verifier the answer is the next attempt's instruction: the agent is asked again
    // with the addition, and the attempt budget still decides how many times that may happen.
    this.pendingPrompt = loop.answerPrompt(text);
    void this.flushLoop();
  }

  /** Stop a running review; the terminal progress stays visible for the reader.
   * @param reason - Why it stopped; the default is an operator action.
   */
  stopLoop(reason: LoopTerminalReason = 'user-cancelled'): void {
    if (this.loop === undefined || !this.loop.active) return;
    this.forgetSettleTimer();
    this.clearLoopDeadline();
    this.abortVerification();
    this.endedAt = undefined;
    this.loop.cancel(reason);
    this.traceLoopEnd(this.loop);
    this.pendingPrompt = undefined;
    this.update({});
  }

  /** Drop the loop entirely, without publishing a cancelled phase.
   * @param reason - Why it was dropped, recorded when it never reached a terminal phase itself.
   */
  forgetLoop(reason: LoopTerminalReason = 'replaced'): void {
    this.stopLoop(reason);
    this.loop = undefined;
  }

  /** Note that an attempt's turn ended; its block may still be arriving.
   * @param sessionId - Session the host reported idle.
   */
  settleLoop(sessionId: string): void {
    const loop = this.loop;
    if (loop === undefined || !loop.active || !loop.settled || loop.sessionId !== sessionId) return;
    this.endedAt ??= Date.now();
    this.trySettleLoop();
  }

  /** Consume the attempt once its result block is committed, or the grace period expires.
   *
   * The final assistant message can land a moment after the idle event, so an empty parse is not yet
   * a failed attempt: the next publish retries, and one timer covers a transcript that never grows.
   */
  private trySettleLoop(): void {
    const loop = this.loop;
    if (loop === undefined || !loop.active || !loop.settled) { this.forgetSettleTimer(); this.endedAt = undefined; return; }
    // Only a turn that actually ended may be consumed: a timer that fired just before the attempt
    // settled must not decide the attempt that replaced it.
    const endedAt = this.endedAt;
    if (endedAt === undefined) { this.forgetSettleTimer(); return; }
    // An independent verifier decides the round; the reply block below stays as its fallback. Its
    // branch keeps its own `verify` sub-state, so this must not announce settling over it.
    if (loop.protocol.verify !== undefined && this.verifier !== undefined) {
      if (!this.verifying && !this.settling) void this.verifyRound(loop);
      return;
    }
    // No forked verifier: reading the reply block, including the grace wait for it, is settling.
    loop.settling();
    const result = parseLoopResult(this.host.reply(), loop.protocol);
    if (result === undefined && Date.now() - endedAt < LOOP_SETTLE_GRACE_MS) {
      if (this.settleTimer === undefined) {
        this.settleTimer = setTimeout(() => { this.settleTimer = undefined; this.trySettleLoop(); }, LOOP_SETTLE_GRACE_MS);
        this.settleTimer.unref();
      }
      return;
    }
    this.forgetSettleTimer();
    this.endedAt = undefined;
    void this.settleChecked(loop, result);
  }

  /** Score one finished round out of band, in a process of its own.
   *
   * Verifier outages retry without spending an attempt. A reply block is a fallback only when the
   * operator enabled it; otherwise the run reports verification unavailable.
   * @param loop - The run whose attempt just finished.
   */
  private async verifyRound(loop: ScoredLoop): Promise<void> {
    if (!this.isCurrent(loop) || this.verifying) return;
    const verifier = this.verifier;
    if (verifier === undefined) return;
    const { step, attempt } = loop.progress;
    const { kind } = loop.protocol;
    const runId = loop.runId;
    // Every started verification is its own task: a failure retry or an operator answer must not
    // reuse the identity or the file of the task it replaced, or a late verdict could decide it.
    const seq = this.verificationSeq += 1;
    const file = verdictFile(this.verdictRoot, runId, kind, step, attempt, seq);
    const identity = verificationId(runId, kind, step, attempt, seq);
    const prompt = loop.protocol.verify!(loop.progress, step, attempt, { file, verificationId: identity }, this.previous);
    // An answer the operator gave after an abstention only adds a condition: the same artifact is
    // judged again, under a fresh identity, and no attempt is consumed for it.
    const answered = this.answerText === undefined ? prompt : `${prompt}\n\n## 操作者的补充判断\n${this.answerText}`;
    this.verifying = true;
    this.verificationIdentity = identity;
    // The sub-state is a fact on the loop, not a note: the progress line and the status bar both read
    // it, and a retry's warning note stays beside it instead of being overwritten by a string.
    loop.verifying();
    const abort = new AbortController();
    this.verifyAbort = abort;
    this.traceEvent('verify', { runId, phase: 'begin', kind, step, attempt, seq, file });
    this.update({});
    let outcome: VerifierOutcome;
    try {
      // The reviewed workspace is declared here, where it is known, so the verifier's artifact check
      // never has to infer it from whatever directory the process happens to run in.
      outcome = abort.signal.aborted ? { type: 'cancelled' } : await verifier.verify({ verificationId: identity, kind, step, attempt, prompt: answered, file,
        workspace: this.localDirectory,
        ...(loop.protocol.artifact === undefined ? {} : { artifact: loop.protocol.artifact }),
        title: `[dsht-verify] ${loop.protocol.title} · ${step}/${attempt}` }, abort.signal);
    } catch (error) {
      outcome = { type: 'unavailable', reason: `verifier failed: ${errorText(error)}` };
    } finally {
      if (this.verifyAbort === abort) {
        this.verifyAbort = undefined;
        this.verifying = false;
      }
    }
    // A newer verification task owns this attempt now: this task's verdict is stale by definition.
    if (this.verificationIdentity !== identity) { this.traceEvent('verify', { runId, phase: 'stale', kind, step, attempt, seq }); return; }
    // Verification outlives nothing: a cancelled or replaced loop must not be settled by its result.
    if (!this.isCurrent(loop) || !loop.settled) { this.traceEvent('verify', { runId, phase: 'abandoned', kind, step, attempt, seq }); return; }
    this.forgetSettleTimer();
    this.endedAt = undefined;
    // The review was cancelled: nothing to decide, and nothing to report as a verdict.
    if (outcome.type === 'cancelled') { this.traceEvent('verify', { runId, phase: 'cancelled', kind, step, attempt, seq }); return; }
    // The host is waiting for a human the verifier cannot answer: stop with the request attached.
    // The verifier is blocked, not broken, so retrying would only hit the same wall three times.
    if (outcome.type === 'needs-human') {
      this.traceEvent('verify', { runId, phase: 'needs-human', kind, step, attempt, seq, request: outcome.request.kind });
      this.clearLoopDeadline();
      loop.human(outcome.request);
      this.traceLoopEnd(loop);
      this.update({});
      return;
    }
    if (outcome.type === 'verified') {
      this.traceEvent('verify', { runId, phase: 'verified', kind, step, attempt, seq,
        score: outcome.result.score ?? -1, blocked: outcome.result.blocked === true, status: outcome.result.status ?? 'none' });
      this.verifierMisses = 0; await this.settleChecked(loop, outcome.result); return;
    }

    // Unavailable is not a verdict, so it never consumes the attempt: retry the verifier, and only
    // then stop the run. Self-scoring is opt-in and is always visible in the progress line.
    // A failure that says it is not retryable (an unconfirmed remote cancel, a bad configuration)
    // would only repeat itself, so it is reported instead of spending the retry budget.
    if (outcome.retryable === false) {
      this.traceEvent('verify', { runId, phase: 'unavailable', kind, step, attempt, seq, retryable: false, reason: outcome.reason.slice(0, 200) });
      loop.note(`⚠ verification unavailable · ${outcome.reason}`);
      this.clearLoopDeadline();
      loop.unavailable();
      this.traceLoopEnd(loop);
      this.update({});
      return;
    }
    this.verifierMisses += 1;
    if (this.verifierMisses <= VERIFIER_RETRIES) {
      this.traceEvent('verify', { runId, phase: 'retry', kind, step, attempt, seq, misses: this.verifierMisses, reason: outcome.reason.slice(0, 200) });
      loop.note(`⚠ verification unavailable · retrying (${outcome.reason})`);
      this.update({});
      void this.verifyRound(loop);
      return;
    }
    if (this.allowSelfFallback) {
      const fallback = parseLoopResult(this.host.reply(), loop.protocol);
      this.traceEvent('verify', { runId, phase: 'fallback', kind, step, attempt, seq, block: fallback !== undefined });
      await this.settleChecked(loop, fallback, fallback === undefined
        ? `⚠ verification fallback · self-reported (and no reply block: ${outcome.reason})`
        : '⚠ verification fallback · self-reported');
      return;
    }
    this.traceEvent('verify', { runId, phase: 'unavailable', kind, step, attempt, seq, retryable: true, misses: this.verifierMisses, reason: outcome.reason.slice(0, 200) });
    loop.note(`⚠ verification unavailable · ${outcome.reason}`);
    this.clearLoopDeadline();
    loop.unavailable();
    this.traceLoopEnd(loop);
    this.update({});
  }

  /** Apply a protocol's own artifact requirement, then settle the attempt.
   *
   * The score is the verifier's judgement; whether the round's conclusion actually reached the
   * artifact is a fact this client checks itself. A hard condition may not be overridden by a score:
   * a round whose section is missing fails even at 10/10, and the missing line is fed back to the
   * next attempt like any other finding. An artifact this client cannot read cannot be checked, so
   * the verdict stands rather than being failed on a boundary.
   * @param loop - The run whose attempt just finished.
   * @param result - Verdict to consume.
   * @param note - Note to show instead, when the check accepted the verdict unchanged.
   */
  private async settleChecked(loop: ScoredLoop, result: LoopResult | undefined, note = ''): Promise<void> {
    if (!this.isCurrent(loop) || !loop.settled || this.settling) return;
    this.settling = true;
    try {
      const marker = result === undefined || result.blocked === true || result.abstained === true
        ? undefined : loop.protocol.artifactMarker?.(loop.progress.step);
      const artifact = loop.protocol.artifact;
      if (marker === undefined || artifact === undefined || result === undefined) { this.settleWith(loop, result, note); return; }
      let text: string | undefined;
      try { text = await readText(join(this.localDirectory, artifact)); }
      catch {
        // An unreadable workspace is a client boundary, not a failed artifact verdict.
        if (this.isCurrent(loop)) this.settleWith(loop, result, note || '⚠ artifact check unavailable · using the verdict');
        return;
      }
      // Reading the artifact is I/O, so the run may have moved on before it came back.
      if (!this.isCurrent(loop) || !loop.settled) return;
      if (text === undefined || text.includes(marker)) { this.settleWith(loop, result, note); return; }
      this.traceEvent('artifact', { phase: 'missing', artifact, step: loop.progress.step, score: result.score ?? -1 });
      const reported = result.score === undefined ? '没有分数' : `${result.score} 分`;
      this.settleWith(loop, { ...result, score: undefined,
        findings: [...(result.findings ?? []), `工作区文件 ${artifact} 缺少本轮小节「${marker}」`] },
      `⚠ artifact check · ${artifact} 缺少本轮小节「${marker}」（验证者给了 ${reported}，本轮不通过）`);
    } finally { this.settling = false; }
  }

  /** Apply one attempt's verdict, and continue the run when it has a next step.
   * @param loop - The run being settled.
   * @param result - Verdict to consume, or undefined when the attempt produced none.
   */
  private settleWith(loop: ScoredLoop, result: LoopResult | undefined, note = ''): void {
    if (!this.isCurrent(loop) || !loop.settled) return;
    const before = loop.progress;
    const step = loop.settle(result);
    // The answer was the condition for this judgment, so it is spent once the verdict is in.
    this.answerText = undefined;
    // A pause is not an end: the run keeps its span (and its deadline) until it is answered or ended.
    if (step.kind !== 'continue' && !loop.active) {
      this.clearLoopDeadline();
      // A decision ended the run: close its trace span with the phase and reason it stopped in.
      this.traceLoopEnd(loop);
    }
    // The note describes the attempt just decided, so it is applied after the state moved on.
    loop.note(note);
    if (step.kind === 'continue') {
      // A retry on the same step carries the verdict that caused it; a new step starts clean.
      this.previous = before.step === loop.progress.step && result !== undefined
        ? { step: before.step, attempt: before.attempt, result } : undefined;
      // A passing verdict advanced the step. When the record verifies first, the new round is
      // verified against the artifact as it stands before anyone is asked to change it.
      if (loop.progress.step !== before.step && this.startsByVerifying(loop)) {
        this.update({});
        this.verifyStep(loop);
        return;
      }
      const findings = result === undefined ? [] : findingsLines(result);
      // `step.prompt` is already brief-aware: a run that began by verifying has sent no prompt yet, so
      // its first work message is the brief rather than a follow-up that describes nothing.
      this.pendingPrompt = [step.prompt, ...findings].join('\n');
    }
    this.update({});
    if (step.kind === 'continue') void this.flushLoop();
  }

  /** Stop an in-flight verification, if any; its result can no longer decide anything. */
  private abortVerification(): void {
    this.verifyAbort?.abort();
    this.verifyAbort = undefined;
    this.verifying = false;
  }

  /** Stop the run because the whole-run budget expired; a budget stop, not a verdict.
   *
   * Any verification in flight is cancelled (bounded, as everywhere else) and its late result can
   * no longer decide anything, because the loop is no longer active.
   */
  private expireLoopDeadline(): void {
    this.deadlineTimer = undefined;
    const loop = this.loop;
    if (loop === undefined || !loop.active) return;
    this.forgetSettleTimer();
    this.abortVerification();
    this.endedAt = undefined;
    loop.note('⚠ deadline reached');
    loop.deadline();
    this.traceLoopEnd(loop);
    this.update({});
  }

  /** Drop the run deadline, if one is armed. */
  private clearLoopDeadline(): void {
    if (this.deadlineTimer === undefined) return;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
  }

  /** Drop a pending settle timer, if any. */
  private forgetSettleTimer(): void {
    if (this.settleTimer === undefined) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
  }

  /** Send the prompt the loop is holding, once the client can actually send it. */
  private async flushLoop(): Promise<void> {
    const loop = this.loop;
    const prompt = this.pendingPrompt;
    if (loop === undefined || prompt === undefined || !this.isCurrent(loop)) return;
    // Nothing of this loop writes while an independent verifier is judging it: the round under
    // verification must be the round that was scored. A prompt that appears meanwhile is sent when
    // the verdict lands (or dropped with the run), never interleaved with the verification.
    if (this.verifying) return;
    const facts = this.host.facts();
    if (facts.sessionId !== loop.sessionId || !facts.online || !facts.ready || facts.busy || facts.pending) return;
    // Consume before awaiting, so a re-entrant update cannot send the same prompt twice.
    this.pendingPrompt = undefined;
    loop.sent();
    this.update({});
    try { if (this.isCurrent(loop)) await this.host.send(prompt); }
    catch (error) {
      // The next prompt was rejected (a waiting interaction, a lost snapshot, offline): the run ends
      // with that reason recorded instead of vanishing without a trace.
      this.rejectLoopSend(loop, error);
    }
  }

}
