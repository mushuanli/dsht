/** One session's mutation admission order, with a control lane that overtakes the normal waiters.
 *
 * The gate serializes the **admission** of a mutation — checking state, deciding, and issuing the
 * request — not the remote mutation itself. A section therefore returns as soon as the request is
 * issued, and the caller awaits the host's answer outside the gate: a `/compact` can take minutes, and
 * holding the gate for it would make `cancel` wait for exactly the operation it exists to interrupt.
 * The `return dispatch()` below is what enforces that: the gate releases when the section *returns*,
 * so even an `async` section holds it only up to its first `await`.
 *
 * Two lanes:
 *
 * * `normal` — a prompt, steering, a host command, an answer, a queue removal: arrival order;
 * * `control` — `cancelTurn`/`interrupt` and `/loop stop`: waits only for the section already running,
 *   so it is admitted ahead of every normal admission that is still waiting.
 *
 * The key is the **target** session, not the selected one: cancelling a forked verifier addresses the
 * verifier's own session, and that must not queue behind the reviewed session's writes.
 */

/** Which queue one mutation admission joins. */
export type MutationLane = 'normal' | 'control';

/** One admission, as the gate reports it so the trace can answer "who dispatched first". */
export interface MutationAdmission {
  /** Session the mutation targets; never inferred from the selection. */
  readonly sessionId: string;
  /** Lane the admission used. */
  readonly lane: MutationLane;
  /** Whether another admission already held this session's gate when this one arrived. */
  readonly waited: boolean;
}

/** One session's admission queue. */
interface Lane {
  /** Whether a section has been admitted and has not returned yet. */
  busy: boolean;
  /** Control waiters, woken before any normal waiter. */
  control: (() => void)[];
  /** Normal waiters, in arrival order. */
  normal: (() => void)[];
}

/** Serializes one session's mutation admissions. */
export class SessionMutationGate {
  private readonly lanes = new Map<string, Lane>();
  /** @param report - Optional observer, called once per admission in dispatch order. */
  constructor(private readonly report?: (admission: MutationAdmission) => void) {}

  /** Wait for this session's turn, then run one section inside the gate.
   *
   * `dispatch` must decide and **issue**: return the promise the caller will await, rather than
   * awaiting it here, or the gate stays held for the whole remote mutation.
   * @param sessionId - Target session the mutation belongs to.
   * @param lane - `control` overtakes waiting normal admissions; `normal` keeps arrival order.
   * @param dispatch - Synchronous decision plus request issue.
   * @returns What `dispatch` returned; a returned promise is adopted, so the caller may await the
   *   host's answer without holding the gate.
   */
  async admit<T>(sessionId: string, lane: MutationLane, dispatch: () => T): Promise<T> {
    const state = this.lanes.get(sessionId) ?? { busy: false, control: [], normal: [] };
    this.lanes.set(sessionId, state);
    const waited = state.busy;
    await this.acquire(state, lane);
    this.report?.({ sessionId, lane, waited });
    try { return dispatch(); } finally { this.release(sessionId, state); }
  }

  /** Take the gate now, or queue for it behind the running section. */
  private async acquire(state: Lane, lane: MutationLane): Promise<void> {
    if (!state.busy) { state.busy = true; return; }
    // The waiter that is woken inherits the gate: `busy` stays true across the handoff, so an
    // admission arriving during it queues instead of overtaking the waiter already promised the turn.
    await new Promise<void>(resolve => (lane === 'control' ? state.control : state.normal).push(resolve));
  }

  /** Hand the gate to the next waiter, control first, or free it. */
  private release(sessionId: string, state: Lane): void {
    const next = state.control.shift() ?? state.normal.shift();
    if (next !== undefined) { next(); return; }
    state.busy = false;
    // A lane nobody is waiting for would otherwise stay behind for the life of the process, and long
    // runs create a session per verification.
    if (this.lanes.get(sessionId) === state) this.lanes.delete(sessionId);
  }
}
