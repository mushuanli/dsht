/** The `/design-review` loop: which round and attempt is in flight, and what happens next.
 *
 * The client drives this because it is the side that reads the score. One `settle` call consumes one
 * finished attempt and, when the loop continues, returns the prompt to send next; the controller
 * owns sending and cancellation, so this class has no I/O and is trivially testable.
 */
import type { DesignReviewProgress } from '../contracts.ts';
import { designReviewBrief, designReviewFollowUp, type ResolvedDesignReview } from './design-review.ts';

/** What one consumed attempt decided: the next prompt, or the end of the run. */
export type ReviewStep =
  | { kind: 'continue'; prompt: string }
  | { kind: 'passed' }
  | { kind: 'exhausted' };

/** One run of the scored loop, tied to the session it reviews. */
export class ReviewRun {
  private round: number;
  private attempt = 1;
  private best = 0;
  private phase: DesignReviewProgress['phase'] = 'reviewing';
  private awaiting = false;

  constructor(readonly sessionId: string, private readonly run: ResolvedDesignReview) {
    this.round = run.from;
  }

  /** Snapshot the UI renders; the loop keeps the authoritative numbers. */
  get progress(): DesignReviewProgress {
    return { ...this.run, round: this.round, attempt: this.attempt, best: this.best, phase: this.phase };
  }

  /** Whether the run may still send or settle an attempt. */
  get active(): boolean { return this.phase === 'reviewing'; }

  /** Whether a prompt was sent and its reply is still outstanding. */
  get settled(): boolean { return this.awaiting; }

  /** The opening prompt; the caller sends it and then calls `sent()`. */
  start(): string { return designReviewBrief(this.run, this.round, this.attempt); }

  /** Record that the outstanding prompt reached the host. */
  sent(): void { this.awaiting = true; }

  /** Consume one finished attempt.
   * @param score - Parsed score, or undefined when the reply carried no usable block.
   * @returns What the loop does next.
   */
  settle(score: number | undefined): ReviewStep {
    this.awaiting = false;
    if (score !== undefined) this.best = Math.max(this.best, score);
    if (score !== undefined && score >= this.run.score) {
      if (this.round >= this.run.to) { this.phase = 'passed'; return { kind: 'passed' }; }
      this.round += 1; this.attempt = 1; this.best = 0;
      return { kind: 'continue', prompt: designReviewFollowUp(this.run, this.round, this.attempt) };
    }
    // A missing or low score is a failed attempt and costs one from the round's budget.
    this.attempt += 1;
    if (this.attempt > this.run.tries) { this.phase = 'exhausted'; return { kind: 'exhausted' }; }
    return { kind: 'continue', prompt: designReviewFollowUp(this.run, this.round, this.attempt) };
  }

  /** Stop the run; a cancelled run never sends again. */
  cancel(): void { this.phase = 'cancelled'; this.awaiting = false; }
}
