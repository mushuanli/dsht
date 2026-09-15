/** Host projection values with per-key watermarks; snapshots never roll back newer updates.
 *
 * The wire shape is decoded by `transport/events.ts`; this class only applies semantic control frames
 * to its own maps, so a host field rename never reaches the session domain.
 */
import type { ControlFrame, ProjectionSnapshot, ProjectionValue, QueuedInput } from '../transport/events.ts';

export type { QueuedInput } from '../transport/events.ts';

interface Entry { baseline: number; values: Record<string, ProjectionValue>; revisions: Map<string, number> }

/** Generation-local projection, inbox and background-job data for every session. */
export class Telemetry {
  private entries = new Map<string, Entry>();
  private queues = new Map<string, QueuedInput[]>();
  private jobs = new Map<string, number>();
  ready = false;

  /** Optionally retain only projection capabilities consumed by this client. */
  constructor(private readonly retainedKeys?: ReadonlySet<string>) {}

  /** Replace all control state on a new stream baseline, then accept replacement frames.
   * @param frame - One normalized session/control frame.
   */
  accept(frame: ControlFrame): void {
    if (frame.kind === 'baseline') {
      this.entries.clear(); this.queues.clear(); this.jobs.clear();
      for (const [id, snapshot] of frame.projections) this.snapshot(id, snapshot);
      for (const [id, items] of frame.queues) this.queues.set(id, [...items]);
      for (const [id, count] of frame.jobs) this.jobs.set(id, count);
      this.ready = true;
      return;
    }
    if (!this.ready) throw new Error('Session control update before baseline');
    if (frame.kind === 'projection') {
      const entry = this.entry(frame.sessionId);
      if (frame.seq < (entry.revisions.get(frame.key) ?? entry.baseline)) return;
      if (this.retainedKeys && !this.retainedKeys.has(frame.key)) return;
      entry.values[frame.key] = frame.value;
      entry.revisions.set(frame.key, frame.seq);
    } else if (frame.kind === 'queue') this.queues.set(frame.sessionId, [...frame.items]);
    else this.jobs.set(frame.sessionId, frame.count);
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
      if (Object.hasOwn(baseline.values, key)) entry.values[key] = baseline.values[key]!;
      else delete entry.values[key];
      entry.revisions.delete(key);
    }
    entry.baseline = baseline.asOfSeq;
  }

  /** Read current values for one session; missing capabilities remain absent.
   * @param id - Selected session identity, if any.
   * @returns Projection values and known queue/job counts.
   */
  view(id?: string): { values: Readonly<Record<string, ProjectionValue>>; queued?: number; jobs?: number } {
    return { values: id ? this.entries.get(id)?.values ?? {} : {},
      queued: id ? this.queues.get(id)?.length : undefined, jobs: id ? this.jobs.get(id) : undefined };
  }

  /** Read the selected session's authoritative pending inputs; absence means no observed queue.
   * @param id - Session identity.
   * @returns Pending inputs in host order.
   */
  pending(id?: string): readonly QueuedInput[] { return id ? this.queues.get(id) ?? [] : []; }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) { entry = { baseline: -1, values: Object.create(null) as Record<string, ProjectionValue>, revisions: new Map() }; this.entries.set(id, entry); }
    return entry;
  }
}
