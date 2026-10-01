/** The dsh Remote facade: one function per endpoint dsht calls.
 *
 * Every request the client makes goes through here, so the wire — endpoint names, `request` versus
 * `_request`, `agentId` lookup arguments, the client's time zone, the one endpoint without a deadline
 * — lives in `transport/` and nowhere else. The functions are deliberately policy-free: one call is
 * one round trip, with no retry, caching, admission or session selection. Callers keep their own
 * ordering rules (the per-session mutation gate) and their own lifecycle.
 *
 * Decoding lives in `dsh-contract.ts`; this file only names endpoints and shapes arguments.
 */
import type { Json } from '../json.ts';
import type { Client, Listener, Subscription } from './client.ts';
import {
  accepted, archivedSessions, commandExecution, fileReferenceCandidates, followFrame, modelCatalog,
  modelSelected, pageResult, presetRows, searchResult, sessionCreated, sessionMetrics, workspaceCreated,
  workspaceDeleted, type CommandExecution, type FileReferenceCandidate, type FollowFrame,
  type ModelCatalog, type CatalogModel, type ModelSelection, type PageResult, type PresetRow,
  type SessionMetrics,
  type PromptRequest, type QueueAction, type SearchItem, type SessionAddress, type SessionRow,
  type WorkspaceRow,
} from './dsh-contract.ts';

export type {
  AssistantStreamFrame, CatalogModel, CommandExecution, ContextMetrics, FileReferenceCandidate,
  FollowFrame, FollowSnapshot, ModelCatalog, ModelSelection, ModelSelectionPair, PageResult, PresetRow,
  PromptRequest, QueueAction, SearchItem, SessionAddress, SessionMetrics, SessionRow, SurfaceOp,
  UsageMetrics, WorkspaceRow,
} from './dsh-contract.ts';

/**
 * Decoders the rest of the application applies to values this facade returns.
 *
 * They are re-exported here so `dsh-contract.ts` stays internal to `transport/`: a session or cost
 * module that needs to read a projection or a frame asks the transport for the decoded vocabulary
 * instead of reaching into the wire module, which
 * `tests/architecture/dependencies.test.ts` ("only the transport decodes host values") enforces.
 */
export { sessionMetrics, surfaceAppends, surfaceOpOf } from './dsh-contract.ts';

/** Where a history page ends and which page before it to read. */
export interface PageRequest {
  readonly address: SessionAddress;
  /** Cursor the record was opened at: pages never include newer records than this. */
  readonly throughSeq: number;
  readonly beforeSeq?: number;
  readonly maxMessages?: number;
}

/** One model choice the operator made for the next request. */
export interface SelectModelRequest {
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** Create or idempotently adopt the session that will own the next turn. */
export async function createSession(client: Client, workspaceId: string, signal?: AbortSignal): Promise<string> {
  return sessionCreated(await client.call('session/create', { request: { workspaceId } }, signal));
}

/** Retitle one session. */
export async function renameSession(client: Client, sessionId: string, title: string, signal?: AbortSignal): Promise<void> {
  await client.call('session/rename', { request: { sessionId, title } }, signal);
}

/** Read the host's bounded global search results. */
export async function searchSessions(client: Client, query: string, signal?: AbortSignal): Promise<{ items: SearchItem[]; hasMore: boolean }> {
  return searchResult(await client.call('session/search', { request: { query } }, signal));
}

/** Read one history page, newest first ending at `beforeSeq`. */
export async function page(client: Client, request: PageRequest, signal?: AbortSignal): Promise<PageResult> {
  return pageResult(await client.call('session/page', { request: { address: request.address,
    throughSeq: request.throughSeq, ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
    ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }) } }, signal));
}

/** Submit one prompt as steering or as the next turn. */
export async function prompt(client: Client, request: PromptRequest, signal?: AbortSignal): Promise<void> {
  accepted(await client.call('session/prompt', { request: {
    sessionId: request.sessionId, requestId: request.requestId, mode: request.delivery,
    content: [{ type: 'text', text: request.text }],
    clientTimeZone: request.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  } }, signal), 'the prompt');
}

/** Ask the host to stop the addressed session's current turn. */
export async function cancel(client: Client, sessionId: string, signal?: AbortSignal): Promise<void> {
  accepted(await client.call('session/cancel', { request: { sessionId } }, signal), 'cancellation');
}

/** Mutate one still-pending input by its durable message identity. */
export async function updateQueue(client: Client, sessionId: string, itemId: string, action: QueueAction, signal?: AbortSignal): Promise<void> {
  accepted(await client.call('session/updateQueue', { request: { sessionId, itemId,
    action: action.kind === 'edit' ? { kind: 'edit', content: [{ type: 'text', text: action.text }] } : { kind: action.kind } } }, signal),
  'the queue change');
}

/** Read the host's model routes, reasoning efforts and provider failures. */
export async function readModelCatalog(client: Client, signal?: AbortSignal): Promise<ModelCatalog> {
  return modelCatalog(await client.call('session/modelCatalog', {}, signal));
}

/** Select the route the next request uses, and let the host persist its default in the background. */
export async function selectModel(client: Client, request: SelectModelRequest, signal?: AbortSignal): Promise<ModelSelection> {
  return modelSelected(await client.call('session/selectModel', { request: { sessionId: request.sessionId,
    provider: request.provider, model: request.model,
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) } }, signal));
}

/** Read the agent-preset roster. */
export async function presets(client: Client, signal?: AbortSignal): Promise<PresetRow[]> {
  return presetRows(await client.call('agentPresets/list', {}, signal));
}

/** Read `@` reference candidates for one session's working directory. */
export async function fileReferences(client: Client, agentId: string, query: string, signal?: AbortSignal): Promise<FileReferenceCandidate[]> {
  return fileReferenceCandidates(await client.call('fileReferences/list', { agentId, query }, signal));
}

/** Run one human command; the host may take minutes, so this call has no deadline of its own.
 * @returns The settled execution, or undefined when the line resolved to no command.
 */
export async function executeCommand(client: Client, agentId: string, line: string,
  submittedAttachments: readonly Json[], signal?: AbortSignal): Promise<CommandExecution | undefined> {
  return commandExecution(await client.call('commands/execute', { agentId, line, submittedAttachments: [...submittedAttachments] }, signal, null));
}

/** Register an existing host directory as a workspace. */
export async function createWorkspace(client: Client, path: string, signal?: AbortSignal): Promise<WorkspaceRow> {
  return workspaceCreated(await client.call('workspace/create', { request: { path } }, signal));
}

/** Remove one workspace registration; directories and sessions are preserved. */
export async function deleteWorkspace(client: Client, workspaceId: string, signal?: AbortSignal): Promise<void> {
  workspaceDeleted(await client.call('workspace/delete', { request: { workspaceId } }, signal));
}

/** Archive one session, asking the host to stop its running work in the same action.
 *
 * Since 0.2 the host refuses an archive that would leave work running (`workspace/session-active`)
 * unless the caller asks for the stop, which is what the operator's confirmation already means.
 * @returns The complete archived session set after the write.
 */
export async function archiveSession(client: Client, sessionId: string, signal?: AbortSignal): Promise<string[]> {
  return archivedSessions(await client.call('workspace/archiveSession', { request: { sessionId, stopActivity: true } }, signal));
}

/** The two host streams without a decoded shape, named so no caller can name an endpoint.
 *
 * The mechanism (mux frame shape, cancellation) stays in `Client`; an arbitrary-endpoint `stream()`
 * would have been a hole in the facade, because a domain could reach any capability without a row in
 * `endpoints.ts`. Both frames are decoded by the subscriber itself: `$events` yields host events and
 * waterfalls, `session/control` yields projection frames.
 */
export function subscribeEvents(client: Client, listener: Listener): Subscription {
  return client.subscribe('$events', {}, listener);
}

/** Subscribe to the session control stream: baselines, projections, and optional queue/job sections. */
export function subscribeControl(client: Client, listener: Listener): Subscription {
  return client.subscribe('session/control', {}, listener);
}

/** What a `session/follow` generation asks the host for. */
export interface FollowRequest {
  readonly address: SessionAddress;
  readonly maxMessages?: number;
}

/** Callbacks of one decoded follow generation.
 *
 * `invalid` exists because the consumers want different failures: a selected session must reopen its
 * generation, while a read-only peek only ends itself. The stream is cancelled after it either way.
 */
export interface FollowListener {
  frame(frame: FollowFrame): void;
  invalid(error: Error): void;
  end(error?: Error): void;
}

/** Follow one session with its frames decoded; the caller owns the subscription. */
export function follow(client: Client, request: FollowRequest, listener: FollowListener): Subscription {
  let subscription: Subscription | undefined;
  let stopped = false;
  const stop = () => { stopped = true; subscription?.cancel(); };
  subscription = client.subscribe('session/follow', { request: { address: request.address,
    maxMessages: request.maxMessages ?? 80, assistantStream: true } }, {
    item: value => {
      if (stopped) return;
      let frame: FollowFrame;
      try { frame = followFrame(value); }
      catch (error) {
        listener.invalid(error instanceof Error ? error : new Error('Invalid session follow frame'));
        stop();
        return;
      }
      listener.frame(frame);
    },
    end: error => { if (!stopped) listener.end(error); },
  });
  if (stopped) subscription.cancel();
  return subscription;
}

/** Answer one pending `$events` waterfall so the host's event chain keeps moving. */
export async function eventResult(client: Client, clientId: string, eventId: string, outcome: Json): Promise<void> {
  await client.call('$events/result', { clientId, eventId, outcome });
}
