/** Host projection values with per-key watermarks; snapshots never roll back newer updates. */
import { array, object, string, type Json, type ObjectValue } from './wire.ts';

/** One host-owned pending input, removable only while its occurrence remains queued. */
export interface QueuedInput { id: string; placement: 'queued' | 'steering' | 'context'; text: string }

function queuedInputs(value: Json | undefined): QueuedInput[] {
  return array(value).map(value => {
    const item = object(value);
    if (!['queued', 'steering', 'context'].includes(string(item.placement))) throw new Error('Invalid queue placement');
    return { id: string(item.id), placement: item.placement as QueuedInput['placement'],
      text: array(object(item.message).content).map(object).map(block => block.type === 'text' ? string(block.text) : `[${string(block.type)}]`).join(' ') };
  });
}

interface Entry { baseline: number; values: ObjectValue; revisions: Map<string, number> }

/** Generation-local projection, inbox and background-job data for every session. */
export class Telemetry {
  private entries = new Map<string, Entry>();
  private queues = new Map<string, QueuedInput[]>();
  private jobs = new Map<string, number>();
  ready = false;

  /** Optionally retain only projection capabilities consumed by this client. */
  constructor(private readonly retainedKeys?: ReadonlySet<string>) {}

  /** Replace all control state on a new stream baseline, then accept replacement frames.
   * @param value - One decoded session/control frame.
   */
  accept(value: unknown): void {
    const frame = object(value);
    if (frame.type === 'baseline') {
      const baseline = object(frame.value);
      this.entries.clear(); this.queues.clear(); this.jobs.clear();
      for (const [id, projection] of Object.entries(object(baseline.projections))) this.snapshot(id, projection);
      for (const [id, items] of Object.entries(object(baseline.queues))) this.queues.set(id, queuedInputs(items));
      for (const [id, items] of Object.entries(object(baseline.jobs))) this.jobs.set(id, activeJobs(items));
      this.ready = true;
      return;
    }
    if (!this.ready) throw new Error('Session control update before baseline');
    const id = string(frame.sessionId);
    if (frame.type === 'projection') {
      const entry = this.entry(id);
      const key = string(frame.key);
      const seq = sequence(frame.seq);
      if (seq < (entry.revisions.get(key) ?? entry.baseline)) return;
      if (frame.value === undefined) throw new Error('Missing projection value');
      if (this.retainedKeys && !this.retainedKeys.has(key)) return;
      entry.values[key] = frame.value;
      entry.revisions.set(key, seq);
    } else if (frame.type === 'queue') this.queues.set(id, queuedInputs(frame.items));
    else if (frame.type === 'jobs') this.jobs.set(id, activeJobs(frame.items));
    else throw new Error('Unknown session control frame');
  }

  /** Merge a complete follow snapshot without restoring absent or older projection values.
   * @param id - Session identity.
   * @param value - Projection baseline, when supplied by the host.
   */
  snapshot(id: string, value: unknown): void {
    if (value === undefined) return;
    const baseline = object(value);
    const seq = sequence(baseline.asOfSeq);
    const values = object(baseline.values);
    const entry = this.entry(id);
    if (seq < entry.baseline) return;
    for (const key of new Set([...Object.keys(entry.values), ...Object.keys(values)])) {
      if (this.retainedKeys && !this.retainedKeys.has(key)) continue;
      if ((entry.revisions.get(key) ?? -1) > seq) continue;
      if (Object.hasOwn(values, key)) entry.values[key] = values[key]!;
      else delete entry.values[key];
      entry.revisions.delete(key);
    }
    entry.baseline = seq;
  }

  /** Read current values for one session; missing capabilities remain absent.
   * @param id - Selected session identity, if any.
   * @returns Projection values and known queue/job counts.
   */
  view(id?: string): { values: ObjectValue; queued?: number; jobs?: number } {
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
    if (!entry) { entry = { baseline: -1, values: Object.create(null) as ObjectValue, revisions: new Map() }; this.entries.set(id, entry); }
    return entry;
  }
}

function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -1) throw new Error('Invalid projection watermark');
  return value;
}

function activeJobs(value: Json | undefined): number {
  return array(value).filter(item => ['running', 'stopping'].includes(string(object(item).status))).length;
}
