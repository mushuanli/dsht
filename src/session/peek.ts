/** Following one session read-only, without selecting it.
 *
 * A verifier's session and a subagent child are both *other* sessions: reading one must not disturb the
 * conversation the reader is in, must not become a second writer, and must release its stream when the
 * view closes. This owns that: one subscription, one transcript, one release — the application wires it
 * and the front end only renders what `snapshot` returns.
 */
import type { Subscription } from '../transport/client.ts';
import type { HostAccess } from '../transport/host.ts';
import type { ObjectValue } from '../transport/wire.ts';
import { releaseHistoryLayout } from './history.ts';
import { Transcript } from './transcript.ts';

/** How much of a followed session the first snapshot asks for; the live tail appends after it. */
const PEEK_MESSAGES = 120;

/** One followed session's read-only state. */
export interface PeekState {
  /** The transcript as the host has streamed it. */
  readonly transcript: Transcript;
  /** True once the stream ended, so a view stops calling it live. */
  readonly ended: boolean;
  /** Set when no address form could be followed. */
  readonly error?: string;
}

/** Follows one session address form at a time, read-only. */
export class SessionPeek {
  private subscription: Subscription | undefined;
  private state: PeekState | undefined;
  /** Address forms left to try, in order; a host may refuse the child form for one delivery mode. */
  private pending: ObjectValue[] = [];
  /** Bumped on every open and close, so a cancelled stream's late frame cannot revive the state. */
  private generation = 0;

  /** @param host - Transport access this client already holds; the peek borrows it, never owns it. */
  constructor(private readonly host: HostAccess) {}

  /** Start following the first address that answers, releasing whatever was followed before.
   * @param addresses - Address forms to try in order.
   * @param onChange - Called when the transcript or the state moves.
   */
  open(addresses: readonly ObjectValue[], onChange: () => void): void {
    this.close();
    // `close` bumped the generation; this open owns the next one and every callback checks it.
    const generation = ++this.generation;
    this.pending = [...addresses];
    this.next(generation, onChange);
  }

  /** Stop following and release the transcript; safe to call when nothing is open. */
  close(): void {
    this.generation += 1;
    this.subscription?.cancel();
    this.subscription = undefined;
    this.pending = [];
    if (this.state === undefined) return;
    releaseHistoryLayout(this.state.transcript);
    this.state.transcript.dispose();
    this.state = undefined;
  }

  /** @returns What a view renders, or undefined when nothing is followed. */
  get snapshot(): PeekState | undefined { return this.state; }

  /** Follow the next address form, or report that none worked.
   * @param generation - The open this attempt belongs to; a superseded one stops silently.
   * @param onChange - Called when the transcript or the state moves.
   */
  private next(generation: number, onChange: () => void): void {
    if (generation !== this.generation) return;
    const address = this.pending.shift();
    if (address === undefined) {
      this.state = { transcript: new Transcript(), ended: true, error: 'the host refused every address form' };
      onChange();
      return;
    }
    const transcript = new Transcript();
    this.state = { transcript, ended: false };
    let attempted = false;
    let subscription: Subscription;
    try {
      subscription = this.host.require().subscribe('session/follow', {
        request: { address, maxMessages: PEEK_MESSAGES, assistantStream: true },
      }, {
        item: value => {
          if (generation !== this.generation) return;
          // A peek is a diagnostic surface: a malformed frame ends it with a reason rather than taking
          // the whole client down the way a selected session's stream would.
          try { transcript.accept(value); } catch { this.state = { transcript, ended: true, error: 'the session stream sent a frame this client cannot read' }; }
          onChange();
        },
        end: error => {
          // A cancelled stream still reports its end; only the live attempt may act on it.
          if (attempted || generation !== this.generation) return;
          attempted = true;
          if (error !== undefined && this.pending.length > 0) { this.next(generation, onChange); return; }
          this.state = { transcript, ended: true, ...(error === undefined ? {} : { error: errorTextOf(error) }) };
          onChange();
        },
      });
    } catch (error) {
      // Offline, or between connection generations: the view says so instead of failing the caller.
      this.state = { transcript, ended: true, error: errorTextOf(error) };
      onChange();
      return;
    }
    this.subscription = subscription;
  }
}

/** One error as displayable text, without importing the whole wire module. */
function errorTextOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
