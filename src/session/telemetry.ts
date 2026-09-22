/** Host projection values with per-key watermarks; snapshots never roll back newer updates.
 *
 * The wire shape is decoded by `transport/events.ts`; this class only applies semantic control frames
 * to its own maps, so a host field rename never reaches the session domain.
 */
import type { ControlFrame, ProjectionSnapshot, ProjectionValue, QueuedInput } from '../transport/events.ts';

export type { QueuedInput } from '../transport/events.ts';

interface Entry { baseline: number; values: Record<string, ProjectionValue>; revisions: Map<string, number> }

export interface TelemetrySnapshot {
  readonly values: Readonly<Record<string, ProjectionValue>>;
  readonly queued?: number;
  readonly jobs?: number;
}

/** The public reader has no projection acceptance or baseline replacement capability. */
export interface TelemetryReader {
  readonly ready: boolean;
  view(id?: string): TelemetrySnapshot;
  pending(id?: string): readonly Readonly<QueuedInput>[];
}

const EMPTY_VALUES = Object.freeze({});
const EMPTY_QUEUE: readonly Readonly<QueuedInput>[] = Object.freeze([]);
const EMPTY_VIEW: TelemetrySnapshot = Object.freeze({ values: EMPTY_VALUES, queued: undefined, jobs: undefined });

/** Copy on admission, not on render; no published nested object aliases a wire frame. */
function retain(value: ProjectionValue): ProjectionValue {
  const copy = structuredClone(value);
  const pending = [copy];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) continue;
    Object.freeze(item);
    for (const child of Object.values(item)) pending.push(child);
  }
  return copy;
}

function retainQueue(items: readonly QueuedInput[]): readonly Readonly<QueuedInput>[] {
  return Object.freeze(items.map(item => Object.freeze({ ...item })));
}

/** Generation-local projection, inbox and background-job data for every session. */
export class Telemetry {
  private entries = new Map<string, Entry>();
  private queues = new Map<string, readonly Readonly<QueuedInput>[]>();
  private readonly views = new Map<string, TelemetrySnapshot>();
  readonly reader: TelemetryReader;
  private jobs = new Map<string, number>();
  ready = false;

  /** Optionally retain only projection capabilities consumed by this client. */
  constructor(private readonly retainedKeys?: ReadonlySet<string>) {
    const telemetry = this;
    this.reader = Object.freeze({
      get ready() { return telemetry.ready; },
      view: (id?: string) => this.view(id), pending: (id?: string) => this.pending(id),
    });
  }

  /** Replace all control state on a new stream baseline, then accept replacement frames.
   * @param frame - One normalized session/control frame.
   */
  accept(frame: ControlFrame): void {
    if (frame.kind === 'baseline') {
      this.entries.clear(); this.queues.clear(); this.jobs.clear(); this.views.clear();
      for (const [id, snapshot] of frame.projections) this.snapshot(id, snapshot);
      for (const [id, items] of frame.queues) this.queues.set(id, retainQueue(items));
      for (const [id, count] of frame.jobs) this.jobs.set(id, count);
      this.ready = true;
      return;
    }
    if (!this.ready) throw new Error('Session control update before baseline');
    if (frame.kind === 'projection') {
      const entry = this.entry(frame.sessionId);
      if (frame.seq < (entry.revisions.get(frame.key) ?? entry.baseline)) return;
      if (this.retainedKeys && !this.retainedKeys.has(frame.key)) return;
      entry.values[frame.key] = retain(frame.value);
      entry.revisions.set(frame.key, frame.seq);
    } else if (frame.kind === 'queue') this.queues.set(frame.sessionId, retainQueue(frame.items));
    else this.jobs.set(frame.sessionId, frame.count);
    this.views.delete(frame.sessionId);
  }

  /** Merge a complete follow snapshot without restoring absent or older projection values.
   * @param id - Session identity.
   * @param baseline - Projection baseline, when supplied by the host.
   */
  snapshot(id: string, baseline: ProjectionSnapshot | undefined): void {
    if (baseline === undefined) return;
    const entry = this.entry(id);
    if (baseline.asOfSeq < entry.baseline) return;
    for (const key of new Set([...Object.keys(entry.values), ...Object.keys(baseline.values)])) {
      if (this.retainedKeys && !this.retainedKeys.has(key)) continue;
      if ((entry.revisions.get(key) ?? -1) > baseline.asOfSeq) continue;
      if (Object.hasOwn(baseline.values, key)) entry.values[key] = retain(baseline.values[key]!);
      else delete entry.values[key];
      entry.revisions.delete(key);
    }
    entry.baseline = baseline.asOfSeq;
    this.views.delete(id);
  }

  /** Read current values for one session; missing capabilities remain absent.
   * @param id - Selected session identity, if any.
   * @returns Projection values and known queue/job counts.
   */
  view(id?: string): TelemetrySnapshot {
    if (!id || !this.entries.has(id) && !this.queues.has(id) && !this.jobs.has(id)) return EMPTY_VIEW;
    let view = this.views.get(id);
    if (!view) {
      view = Object.freeze({ values: Object.freeze({ ...this.entries.get(id)?.values }),
        queued: this.queues.get(id)?.length, jobs: this.jobs.get(id) });
      this.views.set(id, view);
    }
    return view;
  }

  /** Read the selected session's authoritative pending inputs; absence means no observed queue.
   * @param id - Session identity.
   * @returns Pending inputs in host order.
   */
  pending(id?: string): readonly Readonly<QueuedInput>[] { return id ? this.queues.get(id) ?? EMPTY_QUEUE : EMPTY_QUEUE; }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) { entry = { baseline: -1, values: Object.create(null) as Record<string, ProjectionValue>, revisions: new Map() }; this.entries.set(id, entry); }
    return entry;
  }
}
