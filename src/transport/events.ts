/** One place that reads DSH event field names and turns them into semantic host events.
 *
 * Raw wire stops here: no `Json`/`ObjectValue` payload survives into a `HostEvent`, so `connection/`,
 * `session/` and the UI never learn how the host names its fields. Replying `{kind:'next'}` to an
 * unrecognized waterfall is a wire-level obligation of the host's event chain, so it is modelled as
 * `waterfall-delegate` rather than silently dropped.
 */
import { array, errorText, object, string, type Json, type ObjectValue } from './wire.ts';
import { entriesOf, optionalString } from './decode.ts';

/** One selectable answer of a host question, already flattened out of the raw request. */
export interface QuestionOption { label: string; description?: string }

/** One question of an `user-questions/request` waterfall. */
export interface QuestionItem {
  id: string;
  header?: string;
  question: string;
  detail?: string;
  multiSelect: boolean;
  options: readonly QuestionOption[];
}

/** A decoded host event with protocol field names already resolved into domain meaning. */
export type HostEvent =
  | { kind: 'approval-request'; eventId: string; sessionId: string; description: string }
  | { kind: 'question-request'; eventId: string; sessionId: string; questions: readonly QuestionItem[] }
  /** A waterfall this client does not answer; the caller must reply `next` to keep the host chain moving. */
  | { kind: 'waterfall-delegate'; eventId: string }
  | { kind: 'cancel'; eventId: string }
  | { kind: 'agent-status'; sessionId: string; running: boolean }
  | { kind: 'catalog-invalidated' }
  | { kind: 'session-error'; sessionId: string; error: string }
  | { kind: 'control'; frame: ControlFrame };

/** Host notifications that invalidate the model catalog. */
const CATALOG_EVENTS = new Set(['llm/adapters-updated', 'settings/document-updated', 'credentials/reference-updated']);

/** One host-owned pending input, flattened to the text the UI shows. */
export interface QueuedInput { id: string; placement: 'queued' | 'steering' | 'context'; text: string;
  /** Prompt-RPC identity of the submission this occurrence stands for, when the host reports one. */
  rpcId?: string }

/** A capability value the host owns. Individual keys are typed incrementally as they are consumed. */
export type ProjectionValue = Json;

/** One session's projection values and the sequence they describe. */
export interface ProjectionSnapshot { asOfSeq: number; values: Readonly<Record<string, ProjectionValue>> }

/** One decoded `session/control` frame with protocol field names already resolved. */
export type ControlFrame =
  | { kind: 'baseline'; projections: ReadonlyMap<string, ProjectionSnapshot>;
      queues: ReadonlyMap<string, readonly QueuedInput[]>; jobs: ReadonlyMap<string, number> }
  | { kind: 'projection'; sessionId: string; key: string; seq: number; value: ProjectionValue }
  | { kind: 'queue'; sessionId: string; items: readonly QueuedInput[] }
  | { kind: 'jobs'; sessionId: string; count: number };

/** Require a projection watermark rather than accepting a rolled-back value. */
function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -1) throw new Error('Invalid projection watermark');
  return value;
}

/** Read one probe-supplied string out of a value that may be absent or of another shape. */
function probeString(container: unknown, key: string): string | undefined {
  if (container === null || typeof container !== 'object' || Array.isArray(container)) return undefined;
  return optionalString((container as ObjectValue)[key]);
}

/** Flatten one message's content blocks into the single line the composer shows. */
function contentLine(value: Json | undefined): string {
  return array(value).map(object)
    .map(block => block.type === 'text' ? string(block.text) : `[${string(block.type)}]`).join(' ');
}

/** Flatten one session's pending-input list. */
function queuedInputs(value: Json | undefined): QueuedInput[] {
  return array(value).map(raw => {
    const item = object(raw);
    if (!['queued', 'steering', 'context'].includes(string(item.placement))) throw new Error('Invalid queue placement');
    const rpcId = optionalString(item.rpcId);
    return { id: string(item.id), placement: item.placement as QueuedInput['placement'],
      ...(rpcId === undefined ? {} : { rpcId }),
      text: contentLine(object(item.message).content) };
  });
}

/** Pending input as carried by the durable `inbox` session projection, newest shape first.
 *
 * The Host stopped sending the `session/control` queue and job sections, so the same pending input
 * now rides the projection its agent loop already publishes: `next-step` is input the next step will
 * claim as steering, `next-turn` is input that wakes a new turn. Each row is the durable user
 * message itself, so its `id` is the identity `session/updateQueue` addresses and its uploaded
 * `source.rpcId` is the submission this client sent.
 *
 * A projection value belongs to a capability this client merely displays, so a row it cannot read is
 * skipped rather than allowed to fail the control stream the way a malformed frame would.
 * @param value - Raw `inbox` projection cell, or undefined when the host publishes none.
 * @returns Pending inputs in the host's own order, steering first.
 */
export function inboxInputs(value: Json | undefined): QueuedInput[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const inbox = value as ObjectValue;
  const rows: QueuedInput[] = [];
  for (const [key, placement] of [['next-step', 'steering'], ['next-turn', 'queued']] as const) {
    const list = inbox[key];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const message = raw as ObjectValue;
      const id = optionalString(message.id);
      if (id === undefined) continue;
      // Only a submission this client itself sent carries the identity that retires its local row;
      // an injected or model-authored occurrence has none.
      const rpcId = probeString(message.source, 'kind') === 'user' ? probeString(message.source, 'rpcId') : undefined;
      const content = Array.isArray(message.content) ? message.content : [];
      rows.push({ id, placement, ...(rpcId === undefined ? {} : { rpcId }), text: contentLine(content) });
    }
  }
  return rows;
}

/** Count the jobs the host still considers active. */
function activeJobs(value: Json | undefined): number {
  return array(value).filter(item => ['running', 'stopping'].includes(string(object(item).status))).length;
}

/** Decode one projection baseline, as carried by a `session/control` baseline or a follow snapshot. */
export function projectionSnapshot(value: unknown): ProjectionSnapshot | undefined {
  if (value === undefined) return undefined;
  const baseline = object(value);
  return { asOfSeq: sequence(baseline.asOfSeq), values: object(baseline.values) };
}

/** Turn one decoded `session/control` frame into a semantic control frame.
 * @param value - One decoded `session/control` frame.
 * @returns The normalized frame.
 */
export function controlFrame(value: unknown): ControlFrame {
  const frame = object(value);
  if (frame.type === 'baseline') {
    const baseline = object(frame.value);
    // The baseline's sections are capabilities, not a fixed schema: a host that reports no queue or
    // job stream simply omits them, and demanding the newer three-section shape would discard the
    // projection snapshot those hosts do send. An absent section is empty, not an error.
    const projections = entriesOf(baseline.projections)
      .map(([id, snapshot]) => [id, projectionSnapshot(snapshot)!] as const);
    const queues = entriesOf(baseline.queues).map(([id, items]) => [id, queuedInputs(items)] as const);
    const jobs = entriesOf(baseline.jobs).map(([id, items]) => [id, activeJobs(items)] as const);
    return { kind: 'baseline', projections: new Map(projections), queues: new Map(queues), jobs: new Map(jobs) };
  }
  if (frame.type === 'projection' || frame.type === 'queue' || frame.type === 'jobs') {
    const sessionId = string(frame.sessionId);
    if (frame.type === 'projection') {
      if (frame.value === undefined) throw new Error('Missing projection value');
      return { kind: 'projection', sessionId, key: string(frame.key), seq: sequence(frame.seq), value: frame.value };
    }
    if (frame.type === 'queue') return { kind: 'queue', sessionId, items: queuedInputs(frame.items) };
    // The host names the job rows `jobs`; the loopback fixtures used `items`, so accept either.
    return { kind: 'jobs', sessionId, count: activeJobs(frame.jobs ?? frame.items) };
  }
  throw new Error('Unknown session control frame');
}

/** Read the opening `$events` handshake, which binds every later answer to one generation.
 * @param value - One raw `$events` frame.
 * @returns The client identity, or undefined when this is not the ready frame.
 */
export function readyClientId(value: unknown): string | undefined {
  const frame = object(value);
  return frame.type === 'ready' ? string(frame.clientId) : undefined;
}

/** Flatten one raw question into the semantic shape the session domain retains. */
function questionItem(value: Json): QuestionItem {
  const item = object(value);
  const options = array(item.options ?? []).map(raw => {
    const option = object(raw);
    const description = optionalString(option.description);
    return { label: string(option.label), ...(description === undefined ? {} : { description }) };
  });
  const header = optionalString(item.header);
  const detail = optionalString(item.detail);
  return {
    id: string(item.id),
    ...(header === undefined ? {} : { header }),
    question: string(item.question),
    ...(detail === undefined ? {} : { detail }),
    multiSelect: item.multiSelect === true,
    options,
  };
}

/** Decode one `$events` waterfall frame. */
function waterfallEvent(frame: ObjectValue): HostEvent {
  const eventId = string(frame.eventId);
  const sessionId = optionalString(frame.agentId) ?? '';
  if (frame.event === 'approval/request') {
    // The approval body is host-defined and currently rendered verbatim; formatting it here keeps
    // the terminal output byte-identical while removing the raw object from the boundary.
    return { kind: 'approval-request', eventId, sessionId, description: JSON.stringify(frame.request ?? null, null, 2) };
  }
  if (frame.event === 'user-questions/request') {
    try {
      const request = object(frame.request);
      return { kind: 'question-request', eventId, sessionId, questions: array(request.questions ?? []).map(questionItem) };
    } catch {
      // A malformed question still has to be settled, or the host's event chain blocks on it.
      return { kind: 'waterfall-delegate', eventId };
    }
  }
  return { kind: 'waterfall-delegate', eventId };
}

/** Decode one `$events` emit frame this client reacts to. */
function emitEvent(frame: ObjectValue): HostEvent | undefined {
  const name = frame.event;
  if (name === 'api-session/status') {
    const args = array(frame.args);
    if (typeof args[1] !== 'boolean') throw new Error('Invalid session running state');
    return { kind: 'agent-status', sessionId: string(args[0]), running: args[1] };
  }
  if (name === 'api-session/error') {
    const args = array(frame.args);
    return { kind: 'session-error', sessionId: optionalString(args[0]) ?? '', error: errorText(args[1]) };
  }
  if (typeof name === 'string' && CATALOG_EVENTS.has(name)) return { kind: 'catalog-invalidated' };
  return undefined;
}

/** Turn one decoded `$events` frame into a semantic host event.
 *
 * Returns `undefined` for anything this client does not act on, including the `ready` handshake,
 * which belongs to the connection lifecycle rather than to a domain.
 * @param frame - One decoded `$events` frame.
 * @returns The normalized event, or undefined when it is not one this client consumes.
 */
export function hostEvent(value: unknown): HostEvent | undefined {
  try {
    const frame = object(value);
    if (frame.type === 'waterfall') return waterfallEvent(frame);
    if (frame.type === 'cancel') return { kind: 'cancel', eventId: string(frame.eventId) };
    if (frame.type === 'emit') return emitEvent(frame);
  } catch {
    // A frame this client cannot decode is not allowed to fail the whole subscription.
    return undefined;
  }
  return undefined;
}
