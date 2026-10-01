/** The dsh Remote contract dsht consumes, organised by endpoint.
 *
 * **Verified against dsh 0.2.0-rc.2.** Source types, for the next host upgrade:
 *
 * | Endpoint group | Host source |
 * | --- | --- |
 * | `session/*` | `packages/api/session-controller/src/types.ts` |
 * | `workspace/*` | `packages/api/workspace-controller/src/types.ts` |
 * | `commands/execute` | `packages/interaction/commands/src/types.ts` |
 * | `fileReferences/list` | `packages/api/session-controller/src/file-references.ts` |
 * | `agentPresets/list` | `packages/preset/agent-preset-registry/src/types.ts` |
 * | envelope, streams | `packages/client/connection/src/rpc.ts`, `packages/api/gateway/src/stream-protocol.ts` |
 *
 * This file decodes only the fields dsht reads; every other field is ignored on purpose, so an
 * additive host change never reaches the client. Two postures are used deliberately:
 *
 * - **Structured results throw** (`page`, `command`, `search`, `create`): protocol drift must be loud,
 *   because the caller would otherwise act on a value it never received.
 * - **List rows and display data degrade** (`session/list` rows, `presets`, `inbox` rows): one odd row
 *   must not empty a whole list or kill a stream, so a missing field reads as "unknown".
 *
 * **Values are not always objects.** A JSON envelope is always an object, but `0.2` returns an array
 * (`fileReferences/list`), `null` (`session/projections`), or no value at all (`commands/execute` for
 * a line that resolved to nothing), and the values *inside* a projection block include strings,
 * arrays and nulls. A decoder must therefore never apply `object()` to a value it did not verify, and
 * the readers of a retained record must tolerate a record whose `data` is absent. `npm run
 * diagnose:host` prints every one of these types for the host at hand; the upgrade procedure is in
 * `dsh-adapter-plan.md` §7.
 */
import { array, object, string, type Json, type ObjectValue } from '../json.ts';
import { arrayOf, optionalCount, optionalNumber, optionalObject, optionalString } from './decode.ts';

/* ------------------------------------------------------------------ *
 * session/list
 * ------------------------------------------------------------------ */

/** One `session/list` row, reduced to what dsht displays or branches on.
 *
 * `running` and `blank` degrade to `false` rather than throwing: the host always sends them, and a row
 * that lost one is better shown as an ordinary session than dropped from the picker.
 */
export interface SessionRow {
  readonly sessionId: string;
  readonly running: boolean;
  readonly blank: boolean;
  /** Host-reported last-activity epoch; absent when the row carried none. */
  readonly updatedAt?: number;
  /** Display title derived from the row's `title` projection; absent when the host titled nothing. */
  readonly title?: string;
  /** Durable working directory, when the host reports one. */
  readonly cwd?: string;
  readonly parentSessionId?: string;
  /** `'subagent'` for a host-created child. */
  readonly origin?: string;
  /** 0.2+: whether the session currently owns a live agent; absent on an older host. */
  readonly agentAvailable?: boolean;
}

/** Read one row's `title` projection: a bare string, or the `{ title }` block a later host sends. */
function rowTitle(row: Json): string | undefined {
  return projectedTitle(optionalObject(optionalObject(row)?.projections)?.values);
}

/** Read the title out of a `title` projection value, in either shape the host has used.
 *
 * Exported because the live projection store hands the same value to the header before any list row
 * exists; both readers must agree on the shape so a session never shows two different titles.
 * @param values - The projection block's `values`, or one session's whole projection values.
 */
export function projectedTitle(values: Json | undefined): string | undefined {
  const title = optionalObject(values)?.title;
  return optionalString(title) ?? optionalString(optionalObject(title)?.title);
}

/** Decode one `session/list` row.
 * @param value - One raw row.
 * @returns The semantic row dsht retains.
 */
export function sessionRow(value: Json): SessionRow {
  const row = object(value);
  const sessionId = string(row.sessionId);
  const updatedAt = optionalNumber(row.updatedAt);
  const title = rowTitle(row);
  const cwd = optionalString(row.cwd);
  const parentSessionId = optionalString(row.parentSessionId);
  const origin = optionalString(row.origin);
  return { sessionId, running: row.running === true, blank: row.blank === true,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(origin === undefined ? {} : { origin }),
    ...(typeof row.agentAvailable === 'boolean' ? { agentAvailable: row.agentAvailable } : {}) };
}

/** Decode a `session/list` result value. */
export function sessionRows(value: Json | undefined): SessionRow[] {
  return arrayOf(optionalObject(value)?.items).map(sessionRow);
}

/* ------------------------------------------------------------------ *
 * workspace/*
 * ------------------------------------------------------------------ */

/** One `workspace/*` row: the registration and the sessions it accounts for. */
export interface WorkspaceRow {
  readonly workspaceId: string;
  readonly path: string;
  readonly title: string;
  readonly sessionIds: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/** Decode one workspace row. */
export function workspaceRow(value: Json): WorkspaceRow {
  const row = object(value);
  const id = string(row.workspaceId);
  const path = string(row.path);
  const title = optionalString(row.title);
  const createdAt = optionalString(row.createdAt);
  const updatedAt = optionalString(row.updatedAt);
  return { workspaceId: id, path, title: title ?? path,
    sessionIds: arrayOf(row.sessionIds).map(entry => string(entry)),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }) };
}

/** The `workspace/follow` opening baseline: registrations plus the archived session set. */
export interface WorkspaceBaseline {
  readonly items: readonly WorkspaceRow[];
  readonly archivedSessionIds: readonly string[];
}

/** Decode a `workspace/follow` baseline item.
 *
 * The baseline gained `pinnedSessionIds` in 0.2; dsht does not offer pinning, so it is ignored here
 * rather than carried as dead state.
 */
export function workspaceBaseline(value: Json | undefined): WorkspaceBaseline {
  const frame = object(value);
  return { items: arrayOf(frame.items).map(workspaceRow),
    archivedSessionIds: arrayOf(frame.archivedSessionIds).map(entry => string(entry)) };
}

/** Decode a `workspace/create` result: the adopted registration. */
export function workspaceCreated(value: Json | undefined): WorkspaceRow {
  const created = object(value).workspace;
  if (created === undefined) throw new Error('Invalid workspace/create result');
  return workspaceRow(created);
}

/** Decode a `workspace/delete` result, which must confirm the deletion. */
export function workspaceDeleted(value: Json | undefined): true {
  if (object(value).deleted !== true) throw new Error('Host did not confirm workspace removal');
  return true;
}

/* ------------------------------------------------------------------ *
 * session/page, session/search
 * ------------------------------------------------------------------ */

/** Durable address selecting an ordinary session or one direct subagent child.
 *
 * `mode` gained `'unknown'` in 0.2; dsht sends only the two it can justify, so the wider host union
 * never enters the client.
 */
export type SessionAddress =
  | { readonly kind: 'session'; readonly sessionId: string }
  | {
    readonly kind: 'subagent';
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly mode: 'one-shot' | 'continuable';
  };

/** One history page: the raw records a `Transcript` folds, plus whether older pages exist. */
export interface PageResult {
  readonly records: readonly Json[];
  readonly hasMore: boolean;
}

/** Decode a `session/page` result. */
export function pageResult(value: Json | undefined): PageResult {
  const page = object(value);
  if (typeof page.hasMore !== 'boolean') throw new Error('Invalid session page: hasMore');
  return { records: array(page.records), hasMore: page.hasMore };
}

/** One `session/search` hit. */
export interface SearchItem { readonly sessionId: string; readonly snippet: string }

/** Decode a `session/search` result, keeping the host's global truncation flag. */
export function searchResult(value: Json | undefined): { items: SearchItem[]; hasMore: boolean } {
  const result = object(value);
  if (typeof result.hasMore !== 'boolean') throw new Error('Invalid session search response');
  const items = array(result.items).map(entry => {
    const item = object(entry);
    if (typeof item.sessionId !== 'string' || typeof item.snippet !== 'string') {
      throw new Error('Invalid session search item');
    }
    return { sessionId: item.sessionId, snippet: item.snippet };
  });
  return { items, hasMore: result.hasMore };
}

/* ------------------------------------------------------------------ *
 * session/prompt, cancel, updateQueue, rename
 * ------------------------------------------------------------------ */

/** Delivery intent of one prompt: steering waits for the step boundary, queue wakes a new turn. */
export type PromptDelivery = 'steer' | 'queue';

/** One prompt submission as the caller states it; the wire shape stays in `dsh.ts`. */
export interface PromptRequest {
  readonly sessionId: string;
  /** Client-minted identity the host echoes as the durable message's `source.rpcId`. */
  readonly requestId: string;
  readonly delivery: PromptDelivery;
  readonly text: string;
  readonly timeZone?: string;
}

/** Decode a receipt that must confirm acceptance. */
export function accepted(value: Json | undefined, what: string): void {
  if (object(value).accepted !== true) throw new Error(`Host did not accept ${what}`);
}

/** One queue mutation. Edit is text-only since 0.2; dsht removes, so the union stays narrow. */
export type QueueAction = { readonly kind: 'remove' } | { readonly kind: 'steer' }
  | { readonly kind: 'edit'; readonly text: string };

/* ------------------------------------------------------------------ *
 * session/modelCatalog, session/selectModel, agentPresets/list
 * ------------------------------------------------------------------ */

/** One route the next request can use. */
export interface ModelSelection { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }

/** One adapter-owned reasoning choice. */
export interface ReasoningEffort { readonly id: string; readonly name: string; readonly description?: string }

/** One selectable model. */
export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly reasoningEfforts: readonly ReasoningEffort[];
  readonly defaultEffort?: string;
}

/** One provider route with its available models. */
export interface CatalogGroup { readonly id: string; readonly name: string; readonly models: readonly CatalogModel[] }

/** One provider the catalog could not read. */
export interface CatalogFailure { readonly id: string; readonly name: string; readonly message: string }

/** The host catalog; 0.2 lists only providers with at least one available model. */
export interface ModelCatalog {
  readonly default: ModelSelection;
  readonly routableProviders: readonly string[];
  readonly groups: readonly CatalogGroup[];
  readonly failures: readonly CatalogFailure[];
}

/** Decode one model selection. */
export function modelSelection(value: Json | undefined): ModelSelection {
  const selection = object(value);
  const effort = optionalString(selection.reasoningEffort);
  return { provider: string(selection.provider), model: string(selection.model),
    ...(effort === undefined ? {} : { reasoningEffort: effort }) };
}

/** Decode a `session/modelCatalog` result. */
export function modelCatalog(value: Json | undefined): ModelCatalog {
  const catalog = object(value);
  return {
    default: modelSelection(catalog.default),
    routableProviders: array(catalog.routableProviders).map(entry => string(entry)),
    groups: array(catalog.groups).map(entry => {
      const group = object(entry);
      return { id: string(group.id), name: string(group.name), models: array(group.models).map(modelEntry => {
        const model = object(modelEntry);
        const reasoning = optionalObject(model.reasoning);
        const description = optionalString(model.description);
        const defaultEffort = optionalString(reasoning?.defaultEffort);
        return { id: string(model.id), name: string(model.name),
          ...(description === undefined ? {} : { description }),
          reasoningEfforts: arrayOf(reasoning?.efforts).map(effortEntry => {
            const effort = object(effortEntry);
            const effortDescription = optionalString(effort.description);
            return { id: string(effort.id), name: string(effort.name),
              ...(effortDescription === undefined ? {} : { description: effortDescription }) };
          }),
          ...(defaultEffort === undefined ? {} : { defaultEffort }) };
      }) };
    }),
    failures: array(catalog.failures).map(entry => {
      const failure = object(entry);
      return { id: string(failure.id), name: string(failure.name), message: string(failure.message) };
    }),
  };
}

/** One selectable agent preset. */
export interface PresetRow {
  readonly id: string;
  readonly isDefault: boolean;
  readonly name?: string;
  /** Host-marked built-in trust; 0.2 dropped it, so an absent field means "let the id decide". */
  readonly trust?: string;
}

/** Decode an `agentPresets/list` roster.
 *
 * A roster row is display metadata, so an unreadable row is skipped rather than failing the load.
 */
export function presetRows(value: Json | undefined): PresetRow[] {
  const rows: PresetRow[] = [];
  for (const entry of arrayOf(optionalObject(value)?.presets)) {
    const row = optionalObject(entry);
    const id = optionalString(row?.id);
    if (id === undefined) continue;
    const name = optionalString(row?.name);
    const trust = optionalString(row?.trust);
    rows.push({ id, isDefault: row?.isDefault === true,
      ...(name === undefined ? {} : { name }), ...(trust === undefined ? {} : { trust }) });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * commands/execute, fileReferences/list
 * ------------------------------------------------------------------ */

/** One command's settled outcome. `undefined` means the host did not resolve the line at all. */
export interface CommandExecution {
  readonly commandId?: string;
  readonly result: { readonly kind: 'success' | 'error'; readonly text?: string };
}

/** Decode a `commands/execute` result; `undefined` when the host resolved no command. */
export function commandExecution(value: Json | undefined): CommandExecution | undefined {
  if (value === undefined) return undefined;
  const execution = object(value);
  const result = object(execution.result);
  if (result.kind !== 'success' && result.kind !== 'error') throw new Error('Invalid command result kind');
  const text = optionalString(result.text);
  const commandId = optionalString(execution.commandId);
  return { ...(commandId === undefined ? {} : { commandId }),
    result: { kind: result.kind, ...(text === undefined ? {} : { text }) } };
}

/** One `@` reference candidate: a path the composer can insert. */
export interface FileReferenceCandidate { readonly path: string; readonly kind: 'file' | 'directory' }

/** Decode a `fileReferences/list` result, rejecting a candidate whose kind is unknown. */
export function fileReferenceCandidates(value: Json | undefined): FileReferenceCandidate[] {
  return array(value).map(entry => {
    const row = object(entry);
    if (row.kind !== 'file' && row.kind !== 'directory') throw new Error('Unknown file reference kind');
    return { path: string(row.path), kind: row.kind };
  });
}

/* ------------------------------------------------------------------ *
 * session/follow
 * ------------------------------------------------------------------ */

/** One active attempt's presentation baseline: its identity and the raw chunk rows to refold. */
export interface AssistantAttemptBaseline {
  readonly attemptId: string;
  /** Index the next chunk frame must carry. */
  readonly nextIndex: number;
  /** Raw chunk rows, oldest first; the transcript folds them. */
  readonly stream: readonly Json[];
}

/** The opening snapshot of one session-follow generation. */
export interface FollowSnapshot {
  readonly cursor: number;
  readonly hasMore: boolean;
  /** Raw durable records, folded by the transcript. */
  readonly records: readonly Json[];
  /** Whether the opening header proves the log was seeded; absent on an older host. */
  readonly headerSeeded: boolean;
  /** Presentation baseline; absent on a host with no live assistant stream. */
  readonly assistantStream?: { readonly revision: number; readonly activeAttempt?: AssistantAttemptBaseline };
  /** Raw projection baseline block; the projection store reads it. */
  readonly projections?: Json;
}

/** One live assistant presentation frame; the chunk payload stays raw for the transcript to fold. */
export type AssistantStreamFrame =
  | { readonly type: 'start'; readonly revision: number; readonly attemptId: string }
  | { readonly type: 'chunk'; readonly revision: number; readonly attemptId: string; readonly index: number; readonly chunk: Json }
  | { readonly type: 'end'; readonly revision: number; readonly attemptId: string; readonly index: number };

/** How one durable record changes the surface it belongs to.
 *
 * `0.1.x` wrote the bare string `'append'`. `0.2` also *rewrites* history: a record whose op is
 * `replace` carries the content that now belongs to the surface entries `startSeq`…`endSeq`, which is
 * how a compaction re-surfaces an older result. An absent op means append, for hosts that predate the
 * field; an op this client does not know is neither, so the record keeps its data (readers still need
 * it) and the display projection skips it — the same posture the control baseline uses for sections
 * it does not recognize.
 */
export type SurfaceOp =
  | { readonly op: 'append' }
  | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number };

/** Decode one record's surface operation.
 * @param value - Untrusted `surfaceOp` field.
 * @returns The known operation, or undefined for a missing or unrecognized one.
 */
export function surfaceOpOf(value: Json | undefined): SurfaceOp | undefined {
  if (value === 'append') return { op: 'append' };
  const op = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
  if (op === undefined) return undefined;
  if (op.op === 'append') return { op: 'append' };
  const startSeq = optionalNumber(op.startSeq);
  const endSeq = optionalNumber(op.endSeq);
  if (op.op === 'replace' && startSeq !== undefined && endSeq !== undefined) return { op: 'replace', startSeq, endSeq };
  return undefined;
}

/** Whether one record appends to its surface.
 *
 * A missing operation counts as append, because a host that never wrote the field only ever appended.
 * @param value - Untrusted `surfaceOp` field.
 * @returns True when the record adds to the surface rather than rewriting it.
 */
export function surfaceAppends(value: Json | undefined): boolean {
  return value === undefined || surfaceOpOf(value)?.op === 'append';
}

/** One decoded `session/follow` frame.
 *
 * `record` keeps the durable frame raw: the transcript owns record-level fields (event types, chunk
 * rows, message assembly), while this contract owns the *stream envelope* — which frame kind it is
 * and which fields decide stream continuity.
 */
export type FollowFrame =
  | { readonly kind: 'snapshot'; readonly snapshot: FollowSnapshot }
  | { readonly kind: 'record'; readonly record: Json }
  | { readonly kind: 'assistant'; readonly frame: AssistantStreamFrame };

/** Require a finite number rather than letting an unreadable envelope through. */
function requiredNumber(value: Json | undefined, what: string): number {
  const read = optionalNumber(value);
  if (read === undefined) throw new Error(`Invalid session follow frame: ${what}`);
  return read;
}

/** Decode one `session/follow` frame.
 * @param value - Untrusted frame value; anything that is not a known frame is rejected loudly.
 */
export function followFrame(value: unknown): FollowFrame {
  const frame = object(value);
  if (frame.type === 'snapshot') {
    const baseline = optionalObject(frame.assistantStream);
    const attempt = optionalObject(baseline?.activeAttempt);
    const attemptId = optionalString(attempt?.attemptId);
    const header = optionalObject(frame.header);
    return { kind: 'snapshot', snapshot: {
      cursor: requiredNumber(frame.cursor, 'cursor'),
      hasMore: frame.hasMore === true,
      records: array(frame.records),
      headerSeeded: header?.isSeeded === true,
      ...(baseline === undefined ? {} : { assistantStream: { revision: requiredNumber(baseline.revision, 'assistantStream.revision'),
        ...(attempt === undefined || attemptId === undefined ? {} : { activeAttempt: { attemptId,
          nextIndex: requiredNumber(attempt.nextIndex, 'activeAttempt.nextIndex'), stream: array(attempt.stream) } }) } }),
      ...(frame.projections === undefined ? {} : { projections: frame.projections }),
    } };
  }
  if (frame.type === 'event' || frame.type === 'chunks') return { kind: 'record', record: value as Json };
  if (frame.type === 'assistant-stream') {
    const live = object(frame.frame);
    const revision = requiredNumber(live.revision, 'assistantStream.revision');
    const attemptId = string(live.attemptId);
    if (live.type === 'start') return { kind: 'assistant', frame: { type: 'start', revision, attemptId } };
    const index = requiredNumber(live.index, 'assistantStream.index');
    if (live.type === 'chunk') {
      if (live.chunk === undefined) throw new Error('Invalid session follow frame: chunk');
      return { kind: 'assistant', frame: { type: 'chunk', revision, attemptId, index, chunk: live.chunk } };
    }
    if (live.type === 'end') return { kind: 'assistant', frame: { type: 'end', revision, attemptId, index } };
    throw new Error('Unknown assistant stream frame');
  }
  throw new Error('Unknown session follow frame');
}

/* ------------------------------------------------------------------ *
 * The projection values dsht reads
 * ------------------------------------------------------------------ */

/** Model routes the session reports: what the last request used and what the next one will. */
export interface ModelSelectionPair {
  readonly lastUsed?: ModelSelection;
  readonly next?: ModelSelection;
}

/** Approximate context occupancy as the host projects it. */
export interface ContextMetrics {
  readonly projectedTokens?: number;
  readonly pressureTokens?: number;
  readonly window?: number;
}

/** Cumulative token buckets; the three prompt buckets are disjoint from the output one. */
export interface UsageMetrics {
  readonly uncachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Every projection value dsht displays, decoded once.
 *
 * One reader per capability means a view never names a host key: `title`, `agentPreset`,
 * `modelSelection`, `contextPressure`, `tokenUsage` and `sessionStats` are read here and nowhere else,
 * so a renamed or removed projection is one edit in this file.
 */
export interface SessionMetrics {
  readonly title?: string;
  readonly agentPresetId?: string;
  readonly models: ModelSelectionPair;
  readonly context?: ContextMetrics;
  readonly usage?: UsageMetrics;
  readonly turns?: number;
}

/** Read a finite count; a negative or non-numeric value is unknown rather than trusted. */
/** Decode the projection values dsht displays.
 * @param values - One session's projection values, or undefined when the host published none.
 */
export function sessionMetrics(values: Readonly<Record<string, Json>> | undefined): SessionMetrics {
  const read = values ?? {};
  const selection = optionalObject(read.modelSelection);
  const pressure = optionalObject(read.contextPressure);
  const usage = optionalObject(read.tokenUsage);
  const stats = optionalObject(read.sessionStats);
  const context: ContextMetrics = {
    ...(optionalCount(pressure?.projectedTokens) === undefined ? {} : { projectedTokens: optionalCount(pressure?.projectedTokens)! }),
    ...(optionalCount(pressure?.pressureTokens) === undefined ? {} : { pressureTokens: optionalCount(pressure?.pressureTokens)! }),
    ...(optionalCount(pressure?.contextWindow) === undefined ? {} : { window: optionalCount(pressure?.contextWindow)! }),
  };
  const buckets: UsageMetrics = {
    ...(optionalCount(usage?.uncachedInputTokens) === undefined ? {} : { uncachedInputTokens: optionalCount(usage?.uncachedInputTokens)! }),
    ...(optionalCount(usage?.outputTokens) === undefined ? {} : { outputTokens: optionalCount(usage?.outputTokens)! }),
    ...(optionalCount(usage?.cacheReadTokens) === undefined ? {} : { cacheReadTokens: optionalCount(usage?.cacheReadTokens)! }),
    ...(optionalCount(usage?.cacheWriteTokens) === undefined ? {} : { cacheWriteTokens: optionalCount(usage?.cacheWriteTokens)! }),
  };
  const title = projectedTitle(read);
  const agentPresetId = optionalString(read.agentPreset);
  const turns = optionalCount(stats?.turns);
  const lastUsed = selection?.lastUsed;
  const next = selection?.next;
  return {
    ...(title === undefined ? {} : { title }),
    ...(agentPresetId === undefined ? {} : { agentPresetId }),
    // A selection cell is `null` until the host has one; only a real block is decoded.
    models: { ...(optionalObject(lastUsed) === undefined ? {} : { lastUsed: modelSelection(lastUsed) }),
      ...(optionalObject(next) === undefined ? {} : { next: modelSelection(next) }) },
    ...(Object.keys(context).length === 0 ? {} : { context }),
    ...(Object.keys(buckets).length === 0 ? {} : { usage: buckets }),
    ...(turns === undefined ? {} : { turns }),
  };
}

/* ------------------------------------------------------------------ *
 * session/create, session/rename, session/selectModel, archiveSession
 * ------------------------------------------------------------------ */

/** Decode a `session/create` result. */
export function sessionCreated(value: Json | undefined): string {
  return string(object(value).sessionId);
}

/** Decode `session/selectModel`'s normalized selection. */
export function modelSelected(value: Json | undefined): ModelSelection {
  return modelSelection(object(value).selected);
}

/** Decode a `workspace/archiveSession` result: the complete archived set. */
export function archivedSessions(value: Json | undefined): string[] {
  return array(object(value).archivedSessionIds).map(entry => string(entry));
}

/* ------------------------------------------------------------------ *
 * session/control
 * ------------------------------------------------------------------ */

/** One pending input occurrence, flattened from whichever source the host reports. */
export interface QueuedInput {
  readonly id: string;
  readonly placement: 'queued' | 'steering' | 'context';
  readonly text: string;
  /** Prompt-RPC identity of the submission this occurrence stands for, when the host reports one. */
  readonly rpcId?: string;
}

/** Flatten one message's content blocks into the single line the composer shows. */
function contentLine(value: Json | undefined): string {
  return arrayOf(value).map(entry => {
    const block = object(entry);
    return block.type === 'text' ? string(block.text) : `[${string(block.type)}]`;
  }).join(' ');
}

/** Read one probe-supplied string out of a value that may be absent or of another shape. */
function probeString(container: Json | undefined, key: string): string | undefined {
  return optionalString(optionalObject(container)?.[key]);
}

/** Pending input as carried by the durable `inbox` session projection.
 *
 * The host stopped sending the `session/control` queue and job sections, so the same pending input
 * now rides the projection its agent loop already publishes: `next-step` is input the next step will
 * claim as steering, `next-turn` is input that wakes a new turn. Each row is the durable user message
 * itself, so its `id` is the identity `session/updateQueue` addresses and its uploaded
 * `source.rpcId` is the submission this client sent.
 *
 * A projection value belongs to a capability this client merely displays, so a row it cannot read is
 * skipped rather than allowed to fail the control stream the way a malformed frame would.
 * @param value - Raw `inbox` projection cell, or undefined when the host publishes none.
 * @returns Pending inputs in the host's own order, steering first.
 */
export function inboxInputs(value: Json | undefined): QueuedInput[] {
  const inbox = optionalObject(value);
  if (inbox === undefined) return [];
  const rows: QueuedInput[] = [];
  for (const [key, placement] of [['next-step', 'steering'], ['next-turn', 'queued']] as const) {
    for (const raw of arrayOf(inbox[key])) {
      const message = optionalObject(raw);
      if (message === undefined) continue;
      const id = optionalString(message.id);
      if (id === undefined) continue;
      // Only a submission this client itself sent carries the identity that retires its local row;
      // an injected or model-authored occurrence has none.
      const rpcId = probeString(message.source, 'kind') === 'user' ? probeString(message.source, 'rpcId') : undefined;
      rows.push({ id, placement, ...(rpcId === undefined ? {} : { rpcId }), text: contentLine(message.content) });
    }
  }
  return rows;
}
