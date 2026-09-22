/** Admission and cancellation for the application's single foreground operation. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ForegroundKind, ForegroundSnapshot } from '../contracts.ts';

type ForegroundEvent =
  | { phase: 'queued'; kind: ForegroundKind; label: string }
  | { phase: 'begin'; id: number; kind: ForegroundKind; label: string }
  | { phase: 'end'; id: number; kind: ForegroundKind; cancelled: boolean };

interface Operation {
  readonly snapshot: ForegroundSnapshot;
  readonly abort: AbortController;
}

/** Owns scheduling only; the application publishes state and reports action failures. */
export class ForegroundSlot {
  private current?: Operation;
  private readonly owner = new AsyncLocalStorage<number>();
  private readonly waiters: (() => void)[] = [];
  private granted = false;
  private closed = false;
  private sequence = 0;

  constructor(private readonly listener: {
    changed(started: boolean): void;
    trace(event: ForegroundEvent): void;
  }) {}

  /** Only display data crosses the UI boundary; the abort controller stays private. */
  get snapshot(): ForegroundSnapshot | undefined { return this.current?.snapshot; }

  /** An inherited async context is an owner only while that exact operation is active. */
  private ownsCurrent(): boolean {
    return this.current !== undefined && this.owner.getStore() === this.current.snapshot.id;
  }

  /** Nested work shares its owner's signal. Other callers are refused or wait in arrival order.
   * Cancellation is cooperative: admitted work keeps its result/error, and no new nested work starts
   * after cancellation. The slot stays occupied until the admitted work settles.
   */
  async run<T>(kind: ForegroundKind, label: string, work: (signal: AbortSignal) => Promise<T>, wait = false): Promise<T | undefined> {
    if (this.closed) return undefined;
    if (this.ownsCurrent()) {
      const signal = this.current!.abort.signal;
      return signal.aborted ? undefined : await work(signal);
    }
    if (this.current !== undefined || this.granted) {
      if (!wait) return undefined;
      this.listener.trace({ phase: 'queued', kind, label });
      await new Promise<void>(resolve => this.waiters.push(resolve));
      this.granted = false;
      if (this.closed) return undefined;
    }
    const snapshot: ForegroundSnapshot = Object.freeze({ id: ++this.sequence, kind, label, startedAt: Date.now() });
    const operation: Operation = { snapshot, abort: new AbortController() };
    this.current = operation;
    try {
      this.listener.trace({ phase: 'begin', id: snapshot.id, kind, label });
      this.listener.changed(true);
      if (operation.abort.signal.aborted) return undefined;
      return await this.owner.run(snapshot.id, () => work(operation.abort.signal));
    } finally {
      this.current = undefined;
      // Reserve before publishing: an observer may synchronously try to claim the empty slot.
      const next = this.waiters.shift();
      this.granted = next !== undefined;
      try {
        this.listener.trace({ phase: 'end', id: snapshot.id, kind, cancelled: operation.abort.signal.aborted });
        this.listener.changed(false);
      } finally { next?.(); }
    }
  }

  /** Abort cooperatively, keeping the slot until work has settled. */
  cancel(): boolean {
    if (this.current === undefined) return false;
    this.current.abort.abort();
    return true;
  }

  /** Permanently refuse new claims, abort the occupant and release all waiting callers. */
  close(): void {
    this.closed = true;
    this.cancel();
    for (const wake of this.waiters.splice(0)) wake();
  }
}
