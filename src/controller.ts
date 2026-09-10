/** UI state and connection generations for the standalone terminal client. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, HttpError, RemoteError, type Subscription } from './client.ts';
import { AuthenticationRequired } from './auth.ts';
import { resolveTarget, sessionLabel } from './navigation.ts';
import { CostLedger, costRecords } from './cost.ts';
import { Telemetry } from './telemetry.ts';
import { Transcript, toolLine } from './transcript.ts';
import { releaseHistoryLayout } from './history.ts';
import { DEFAULT_HISTORY_LIMITS, type HistoryLimits } from './memory.ts';
import { fileReferences, type FileReference } from './references.ts';
import { array, errorText, object, string, type Json, type ObjectValue } from './wire.ts';

/** Resolved navigation-removal identity; empty marks a fresh blank, idle session eligible for immediate archival. */
export interface RemovalTarget { kind: 'workspace' | 'session'; id: string; name: string; path?: string; empty?: boolean }

/** State shared by the picker and conversation view. */
export interface State {
  version: number;
  online: boolean;
  busy: boolean;
  screen: 'workspaces' | 'sessions' | 'chat' | 'path';
  status: string;
  error: string;
  workspaces: ObjectValue[];
  sessions: ObjectValue[];
  showAllSessions: boolean;
  workspaceId?: string;
  sessionId?: string;
  pending: ObjectValue[];
  controlError?: string;
  modelError?: string;
  presetError?: string;
  presets?: ObjectValue[];
  defaultModel?: ObjectValue;
  transcript: Transcript;
}

/** Bounded search results contain navigation summaries, never complete message bodies. */
export interface HistorySearch {
  items: { seq: number; role: string; preview: string }[];
  truncated: boolean;
}

/** Wire addresses for one `session/list` row, in the order the cost scan should try them.
 *
 * A subagent child is reachable only under its durable parent, and the list row omits the delivery
 * mode, so both modes are offered with the continuable form first.
 * @param session - One row from the host session list.
 * @returns One plain-session address, or both subagent forms when the row is a child.
 */
export function costAddresses(session: ObjectValue): ObjectValue[] {
  const sessionId = string(session.sessionId);
  const parentSessionId = typeof session.parentSessionId === 'string' ? session.parentSessionId : '';
  if (session.origin !== 'subagent' || parentSessionId === '') return [{ kind: 'session', sessionId }];
  return [
    { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'continuable' },
    { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'one-shot' },
  ];
}

/** Owns reconnects and subscriptions. User commands remain single-attempt operations. */
export class Controller {
  state: State = { version: 0, online: false, busy: false, screen: 'workspaces', status: 'Connecting…',
    error: '', workspaces: [], sessions: [], showAllSessions: false, pending: [], transcript: new Transcript() };
  private observers = new Set<() => void>();
  private interactions = new Map<string, ObjectValue>();
  private abort = new AbortController();
  private client: Client | undefined;
  private clientId = '';
  private follow: Subscription | undefined;
  private runTask: Promise<void> | undefined;
  private generationFailed: ((error: Error) => void) | undefined;
  private selection = 0;
  private historyPinned = false;
  telemetry = new Telemetry(new Set(['title', 'modelSelection', 'contextPressure', 'tokenUsage', 'sessionStats', 'agentPreset']));
  private observedRunningAt = new Map<string, number>();
  private presetClient?: Client;
  private catalogRevision = 0;
  private catalogTasks = new Set<Promise<void>>();
  private runningUpdates = new Map<string, boolean>();
  private stoppingSession?: string;
  private interruptTask: Promise<boolean> | undefined;
  private admission: Promise<Json | undefined> | undefined;
  private costUpdates = new Map<string, number>();
  private costAbort?: AbortController;
  private costTask: Promise<void> | undefined;
  private costTimer: ReturnType<typeof setInterval> | undefined;

  /** Host running state covers model generation, tools, and waits between assistant attempts. */
  get running(): boolean {
    const id = this.state.sessionId;
    return id !== undefined && (this.runningUpdates.get(id)
      ?? this.state.sessions.find(row => row.sessionId === id)?.running === true);
  }

  /** Current title projection, falling back to the list title and then the session ID. */
  get sessionName(): string | undefined {
    const id = this.state.sessionId;
    if (!id) return;
    const title = this.telemetry.view(id).values.title;
    const row = this.state.sessions.find(item => item.sessionId === id);
    return title !== undefined ? sessionLabel({ sessionId: id, projections: { values: { title } } })
      : row ? sessionLabel(row) : id;
  }

  /** Current agent-preset name, matching the web header's built-in labels and custom metadata. */
  get sessionMode(): string | undefined {
    if (!this.state.sessionId) return undefined;
    const id = this.telemetry.view(this.state.sessionId).values.agentPreset;
    if (typeof id !== 'string') return undefined;
    const preset = this.state.presets?.find(item => item.id === id);
    const builtIn = new Map([['standard', 'Standard mode'], ['ptc', 'PTC mode'], ['minimal', 'Minimal mode'], ['cordis', 'Creator mode']]);
    return preset?.trust === 'system' && builtIn.has(id) ? builtIn.get(id)
      : typeof preset?.name === 'string' ? preset.name : id;
  }

  /** Load the optional preset roster once per connection, only when a session names a preset. */
  loadPresetNames(): void {
    const client = this.client;
    if (!client || !this.state.online || this.presetClient === client) return;
    this.presetClient = client;
    const task = client.call('agentPresets/list', {}).then(value => {
      if (client === this.client) this.update({ presets: array(object(value).presets).map(object), presetError: undefined });
    }).catch(error => {
      if (client === this.client) this.update({ presets: [], presetError: errorText(error) });
    });
    this.catalogTasks.add(task);
    void task.finally(() => this.catalogTasks.delete(task));
  }

  /** Fetch current model routes and adapter-owned reasoning choices for the selected session.
   * @returns Host catalog; provider failures remain available to the selector.
   */
  async modelCatalog(): Promise<ObjectValue> {
    const sessionId = this.sessionId;
    const selection = this.selection;
    const value = object(await this.host.call('session/modelCatalog', {}));
    if (selection !== this.selection || sessionId !== this.state.sessionId) throw new Error('Session changed while loading models');
    return value;
  }

  /** Select the next request's model; the host also attempts to save its deployment default.
   * @param provider - Host provider route ID.
   * @param model - Exact model ID.
   * @param reasoningEffort - Optional adapter-owned effort ID; omission uses its default.
   */
  async selectModel(provider: string, model: string, reasoningEffort?: string): Promise<void> {
    const sessionId = this.sessionId;
    const selection = this.selection;
    const selected = object(object(await this.host.call('session/selectModel', { request: {
      sessionId, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    } })).selected);
    if (selection !== this.selection || sessionId !== this.state.sessionId) return;
    this.update({ status: `Next request: ${string(selected.provider)} / ${string(selected.model)}${selected.reasoningEffort ? ` · ${string(selected.reasoningEffort)}` : ''}` });
    this.refreshCatalog(this.host);
  }

  /** Epoch start from the retained turn log, or when this client first observed the run. */
  get workingSince(): number | undefined {
    if (!this.running || !this.state.sessionId) return undefined;
    return this.state.transcript.activeTurnStartedAt ?? this.observedRunningAt.get(this.state.sessionId);
  }

  /** Stop the selected turn, or allow exit only while idle. Repeated keys share one request.
   * @param force - Send an explicit cancellation even when the cached running flag is idle.
   * @returns True when the caller may exit; cancellation failures retain the client.
   */
  interrupt(force = false): Promise<boolean> {
    if (this.interruptTask) return this.interruptTask;
    if (!force && !this.running && !this.admission && this.state.pending.length === 0) {
      return Promise.resolve(!this.state.busy);
    }
    const sessionId = this.sessionId;
    this.stoppingSession = sessionId;
    this.update({ status: 'Stopping…', error: '' });
    const task = (async () => {
      try {
        // Admission must settle before cancellation can address the newly submitted turn.
        // The prompt caller reports admission failures; an existing turn still needs cancellation.
        await this.admission?.catch(() => undefined);
        await this.host.call('session/cancel', { request: { sessionId } });
        if (this.stoppingSession === sessionId && this.state.sessionId === sessionId) this.update({ status: 'Cancellation requested · waiting for host' });
      } catch (error) { this.stoppingSession = undefined; this.update({ status: 'Cancellation failed', error: errorText(error) }); }
      return false;
    })();
    this.interruptTask = task;
    void task.finally(() => { this.interruptTask = undefined; });
    return task;
  }
  constructor(readonly base: string, token: string | undefined, readonly initialSession?: string,
    private makeClient: () => Client = () => new Client(base),
    private authenticate: (client: Client) => Promise<void> = client => client.authenticate(token ?? ''), readonly costs?: CostLedger, readonly historyLimits: HistoryLimits = DEFAULT_HISTORY_LIMITS) {}

  /** React-compatible state subscription. */
  subscribe = (listener: () => void): (() => void) => {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  };
  /** Snapshot identity changes only when the controller publishes. */
  snapshot = (): State => this.state;

  /** Start one retry loop, with a fresh snapshot generation after every disconnect. */
  start(): void { this.runTask ??= this.run(); }

  /** Cancel retries and HTTP, close the socket, and wait for the loop to settle. */
  async stop(): Promise<void> {
    this.abort.abort();
    clearInterval(this.costTimer);
    this.generationFailed?.(new Error('Client stopped'));
    await this.client?.close();
    await this.runTask;
    await this.interruptTask;
    await Promise.all(this.catalogTasks);
    await this.costTask;
    this.releaseTranscript();
  }

  /** Keep history stable while the user reads, searches, or expands it; trim again at the live tail.
   * @param pinned - Whether the main transcript is actively being read away from its tail.
   */
  pinHistory(pinned: boolean): void {
    this.historyPinned = pinned;
    if (!pinned && this.reclaimHistory()) this.update({});
  }

  private reclaimHistory(): number {
    if (this.historyPinned || !this.state.online) return 0;
    const removed = this.state.transcript.trimHistory(this.historyLimits);
    if (removed) releaseHistoryLayout(this.state.transcript);
    return removed;
  }

  private releaseTranscript(): void {
    releaseHistoryLayout(this.state.transcript);
    this.state.transcript.dispose(); this.historyPinned = false;
  }

  /** Stop the selected turn and then close, so quitting does not leave host work running.
   * An idle session stays untouched, and an in-flight cancellation is awaited rather than repeated.
   */
  async shutdown(): Promise<void> {
    if (this.interruptTask || this.running || this.admission) await this.interrupt(true);
    await this.stop();
  }

  /** Run a UI operation and expose errors without destroying the current input. */
  async perform(operation: () => Promise<void>): Promise<boolean> {
    if (this.state.busy || !this.state.online) return false;
    this.update({ busy: true, error: '' });
    try { await operation(); return true; }
    catch (error) { this.update({ error: errorText(error) }); return false; }
    finally { this.update({ busy: false }); }
  }

  /** Refresh all HTTP-visible sessions without changing the selected conversation.
   * @param signal - Optional cancellation for an explicit /cost refresh.
   */
  async refreshCosts(signal: AbortSignal = this.abort.signal): Promise<void> {
    if (!this.costs) return;
    if (this.costTask) {
      const cancel = () => this.costAbort?.abort();
      signal.addEventListener('abort', cancel, { once: true });
      try { await this.costTask; } finally { signal.removeEventListener('abort', cancel); }
      return;
    }
    this.costAbort = new AbortController();
    signal = AbortSignal.any([signal, this.abort.signal, this.costAbort.signal]);
    const ledger = this.costs; const client = this.host;
    ledger.scanning = true; ledger.error = ''; this.update({});
    const task = (async () => {
      try {
        const sessions = array(object(await client.call('session/list', { _request: {} }, signal)).items).map(object);
        signal.throwIfAborted();
        const failures: string[] = [];
        for (const session of sessions) {
          signal.throwIfAborted();
          const sessionId = string(session.sessionId);
          if (!session.running && typeof session.updatedAt === 'number' && this.costUpdates.get(sessionId) === session.updatedAt) continue;
          try {
            const history = await this.sessionCostHistory(session, signal);
            await ledger.replace(sessionId, history.cursor, history.events);
            if (!session.running && typeof session.updatedAt === 'number') this.costUpdates.set(sessionId, session.updatedAt);
            this.update({});
          } catch (error) {
            // One unreachable or rejected session must not freeze every other session's rates.
            signal.throwIfAborted();
            failures.push(`${sessionId}: ${errorText(error)}`);
          }
        }
        ledger.error = failures.length === 0 ? '' : `${failures.length} of ${sessions.length} sessions failed: ${failures[0]}`;
        ledger.scannedAt = Date.now();
      } catch (error) { ledger.error = errorText(error); }
      finally { ledger.scanning = false; this.update({}); }
    })();
    this.costTask = task;
    try { await task; } finally { this.costTask = undefined; }
  }

  /** Read one session's complete cost history, retrying a subagent child with its other delivery mode. */
  private async sessionCostHistory(session: ObjectValue, signal: AbortSignal): Promise<{ cursor: number; events: ObjectValue[] }> {
    let lastError: unknown;
    for (const address of costAddresses(session)) {
      try { return await this.readCostHistory(address, signal); }
      catch (error) {
        lastError = error;
        // Only a delivery-mode mismatch justifies the other form; every other failure is final here.
        if (!(error instanceof RemoteError && error.code === 'subagent/unauthorized')) throw error;
      }
    }
    throw lastError;
  }

  /** Page one addressed session's history into the billing events the ledger folds. */
  private async readCostHistory(address: ObjectValue, signal: AbortSignal): Promise<{ cursor: number; events: ObjectValue[] }> {
    const client = this.host;
    const snapshot = await new Promise<ObjectValue>((resolve, reject) => {
      let sub: Subscription | undefined;
      const timeout = setTimeout(() => finish(new Error('Cost history snapshot timed out')), client.timeoutMs);
      const onAbort = () => finish(new Error('Cost refresh cancelled'));
      const finish = (error?: Error, frame?: ObjectValue) => {
        clearTimeout(timeout); signal.removeEventListener('abort', onAbort); sub?.cancel();
        if (error) reject(error); else resolve(frame!);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try { sub = client.subscribe('session/follow', { request: { address, maxMessages: 80, assistantStream: true } }, {
        item: value => { const frame = object(value); if (frame.type === 'snapshot') finish(undefined, frame); },
        end: error => finish(error ?? new Error('Cost history stream ended')),
      }); } catch (error) { finish(error instanceof Error ? error : new Error(errorText(error))); }
    });
    const cursor = snapshot.cursor;
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor)) throw new Error('Invalid cost history cursor');
    let page = snapshot; const events: ObjectValue[] = [];
    while (true) {
      signal.throwIfAborted();
      const records = array(page.records);
      events.push(...costRecords(records));
      if (!page.hasMore) break;
      const seqs = records.map(r => object(object(r).event).seq);
      if (!seqs.length || seqs.some(n => typeof n !== 'number' || !Number.isSafeInteger(n))) throw new Error('Invalid cost history page');
      const beforeSeq = Math.min(...seqs as number[]);
      page = object(await client.call('session/page', { request: { address, throughSeq: cursor, beforeSeq, maxMessages: 80 } }, signal));
      if (page.hasMore && array(page.records).every(r => Number(object(object(r).event).seq) >= beforeSeq)) throw new Error('Cost history page did not advance');
    }
    if (object(snapshot.header).isSeeded === true && !events.some(e => e.type === 'session/end-seed' && object(e.data).inherited === true)) throw new Error('Cannot attribute inherited session usage');
    return { cursor, events };
  }

  /** Refresh both lists from the host, then show the requested picker. */
  async showPicker(screen: 'workspaces' | 'sessions'): Promise<void> {
    const [workspaces, sessions] = await Promise.all([this.host.listWorkspaces(), this.host.listSessions()]);
    this.update({ screen, workspaces, sessions });
  }

  /** Resolve a removal command to one reviewable object without changing the selection.
   * @param kind - Workspace registration removal or session archival.
   * @param query - Exact name, ID, or unambiguous ID prefix.
   * @returns The fixed identity and display details for confirmation.
   */
  async removalTarget(kind: 'workspace' | 'session', query: string): Promise<RemovalTarget> {
    const items = kind === 'workspace' ? await this.host.listWorkspaces() : await this.host.listSessions();
    const row = resolveTarget(items, query, kind === 'workspace' ? 'workspaceId' : 'sessionId',
      item => kind === 'workspace' ? [string(item.title), string(item.path)] : [sessionLabel(item)]);
    return kind === 'workspace' ? { kind, id: string(row.workspaceId), name: string(row.title), path: string(row.path) }
      : { kind, id: string(row.sessionId), name: sessionLabel(row),
        empty: row.blank === true && row.running === false
          && !this.runningUpdates.get(string(row.sessionId))
          && !(this.telemetry.view(string(row.sessionId)).queued ?? 0)
          && !(this.telemetry.view(string(row.sessionId)).jobs ?? 0)
          && !(this.state.sessionId === row.sessionId && this.admission) };

  }

  /** Apply a confirmed removal or freshly verified empty-session archival; directories and logs are preserved.
   * @param target - Exact workspace or session identity reviewed by the user.
   */
  async removeTarget(target: RemovalTarget): Promise<void> {
    const client = this.host;
    const receipt = object(await client.call(target.kind === 'workspace' ? 'workspace/delete' : 'workspace/archiveSession', {
      request: target.kind === 'workspace' ? { workspaceId: target.id } : { sessionId: target.id },
    }));
    if (client !== this.client) return;
    if (target.kind === 'session') {
      client.archivedSessionIds = new Set(array(receipt.archivedSessionIds).map(string));
      if (this.state.sessionId === target.id) {
        this.pickWorkspace(this.state.workspaceId);
      }
    } else {
      if (receipt.deleted !== true) throw new Error('Host did not confirm workspace removal');
      this.update({ workspaces: this.state.workspaces.filter(row => row.workspaceId !== target.id),
        ...(this.state.workspaceId === target.id ? { workspaceId: undefined } : {}) });
    }
    this.update({ screen: target.kind === 'workspace' ? 'workspaces' : 'sessions',
      status: target.kind === 'workspace' ? 'Workspace registration removed' : 'Session archived' });
    // A refresh failure must not make a successful mutation look like a rejected deletion.
    try { await this.showPicker(target.kind === 'workspace' ? 'workspaces' : 'sessions'); }
    catch (error) { this.update({ error: `Removal completed; list refresh failed: ${errorText(error)}` }); }
  }

  /** Pick a workspace, or use all sessions when the identity is omitted. */
  pickWorkspace(workspaceId?: string): void {
    this.selection++;
    this.follow?.cancel(); this.follow = undefined;
    this.releaseTranscript();
    this.update({ workspaceId, sessionId: undefined, showAllSessions: false, transcript: new Transcript(), screen: 'sessions' });
  }

  /** Open a workspace picker, or resolve a workspace by ID, exact title/path, or unique ID prefix. */
  async switchWorkspace(query?: string): Promise<void> {
    if (!query) { await this.showPicker('workspaces'); return; }
    const workspaces = await this.host.listWorkspaces();
    const workspace = resolveTarget(workspaces, query, 'workspaceId', item => [string(item.title), string(item.path)]);
    const sessions = await this.host.listSessions();
    this.update({ workspaces, sessions });
    this.pickWorkspace(string(workspace.workspaceId));
  }

  /** Guide workspace selection, list all sessions with `all`, or resolve an exact session target. */
  async switchSession(query?: string): Promise<void> {
    if (!query || query === 'all') {
      await this.showPicker(query === 'all' || this.state.workspaceId ? 'sessions' : 'workspaces');
      this.update({ showAllSessions: query === 'all' });
      return;
    }
    const [workspaces, sessions] = await Promise.all([this.host.listWorkspaces(), this.host.listSessions()]);
    const session = resolveTarget(sessions, query, 'sessionId', item => [sessionLabel(item)]);
    this.update({ workspaces, sessions });
    await this.selectSession(string(session.sessionId));
  }

  /** Prompt for a host path without starting a local agent. */
  enterPath(): void { this.update({ screen: 'path' }); }

  /** Register a host directory and move to its session picker. */
  async createWorkspace(path: string): Promise<void> {
    const result = object(await this.host.call('workspace/create', { request: { path } }));
    const workspace = object(result.workspace);
    await this.showPicker('workspaces');
    this.pickWorkspace(string(workspace.workspaceId));
  }

  /** Create a session only after the user explicitly selects New session. */
  async createSession(): Promise<void> {
    if (!this.state.workspaceId) throw new Error('Select a workspace before creating a session');
    const result = object(await this.host.call('session/create', { request: { workspaceId: this.state.workspaceId } }));
    await this.selectSession(string(result.sessionId));
  }

  /** Replace the selected transcript and cancel its preceding follow stream. */
  async selectSession(sessionId: string): Promise<void> {
    this.stoppingSession = undefined;
    const selection = ++this.selection;
    this.follow?.cancel(); this.follow = undefined;
    this.releaseTranscript();
    const transcript = new Transcript();
    const workspace = this.state.workspaces.find(item => array(item.sessionIds).includes(sessionId));
    const workspaceId = workspace ? string(workspace.workspaceId)
      : this.state.sessions.some(item => item.sessionId === sessionId) ? undefined : this.state.workspaceId;
    if (!this.observedRunningAt.has(sessionId)) this.observedRunningAt.set(sessionId, Date.now());
    this.update({ sessionId, workspaceId, showAllSessions: false, transcript, screen: 'chat', status: 'Loading session…' });
    this.follow = this.host.subscribe('session/follow', {
      request: { address: { kind: 'session', sessionId }, maxMessages: 80, assistantStream: true },
    }, {
      item: value => {
        if (selection !== this.selection) return;
        try {
          transcript.accept(value);
          this.reclaimHistory();
          const frame = object(value);
          if (frame.type === 'snapshot') this.telemetry.snapshot(sessionId, frame.projections);
          this.update({ transcript, status: this.stoppingSession === sessionId ? this.state.status : transcript.hasLiveContent ? 'Responding…' : 'Connected' });
        } catch (error) { this.generationFailed?.(new Error(errorText(error))); }
      },
      end: error => {
        if (selection !== this.selection) return;
        transcript.ready = false;
        this.update({ status: 'Session disconnected', error: errorText(error ?? 'Session stream ended') });
      },
    });
  }

  /** Wait for the selected follow snapshot, failing on disconnect or cancellation.
   * @param signal - Cancels waiting without closing the session.
   */
  async waitForHistory(signal: AbortSignal): Promise<void> {
    const transcript = this.state.transcript;
    const deadline = Date.now() + this.host.timeoutMs;
    while (!transcript.ready) {
      signal.throwIfAborted();
      if (!this.state.online || this.state.transcript !== transcript) throw new Error('Session changed while loading history');
      if (Date.now() >= deadline) throw new Error('Session snapshot timed out');
      await delay(20, undefined, { signal });
    }
  }

  /** Search the host's bounded global results, optionally retaining workspace members.
   * @param query - Literal message text.
   * @param workspaceOnly - Restrict returned hits to the selected workspace's session IDs.
   * @param signal - Cancels the HTTP search.
   * @returns Session snippets and the global truncation flag, preserved after filtering.
   */
  async searchSessions(query: string, workspaceOnly: boolean, signal: AbortSignal): Promise<{ items: ObjectValue[]; hasMore: boolean }> {
    const workspace = this.state.workspaces.find(item => item.workspaceId === this.state.workspaceId);
    if (workspaceOnly && !workspace) throw new Error('Select a workspace first');
    const result = object(await this.host.call('session/search', { request: { query } }, signal));
    if (!Array.isArray(result.items) || typeof result.hasMore !== 'boolean') throw new Error('Invalid session search response');
    const items = result.items.map(value => {
      const item = object(value);
      if (typeof item.sessionId !== 'string' || typeof item.snippet !== 'string') throw new Error('Invalid session search item');
      return item;
    });
    const ids = new Set(array(workspace?.sessionIds ?? []));
    return { items: workspaceOnly ? items.filter(item => ids.has(item.sessionId!)) : items, hasMore: result.hasMore };
  }

  /** Search paths on the host; does not read or upload file contents.
   * @param query - Path text after @, relative to the selected session cwd.
   * @param signal - Cancels an obsolete composer lookup.
   * @returns Validated candidates in host order.
   */
  async references(query: string, signal: AbortSignal): Promise<FileReference[]> {
    return fileReferences(await this.host.call('fileReferences/list', { agentId: this.sessionId, query }, signal));
  }

  /** Admit a prompt once; a failed response can have an uncertain delivery outcome. */
  async prompt(text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    this.stoppingSession = undefined;
    if (!this.state.transcript.ready) throw new Error('Wait for the session snapshot before sending');
    const admission = this.host.call('session/prompt', { request: {
      sessionId: this.sessionId, requestId: randomUUID(), mode,
      content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } });
    this.admission = admission;
    try { await admission; } finally { if (this.admission === admission) this.admission = undefined; }
    this.update({ status: 'Accepted · waiting for host' });
  }

  /** Cancel the active turn; pending queue items remain host-owned. */
  async cancelTurn(): Promise<void> {
    await this.host.call('session/cancel', { request: { sessionId: this.sessionId } });
    this.update({ status: 'Cancellation requested' });
  }

  /** Add a page before the retained window using its fixed opening cut. */
  async older(signal?: AbortSignal, transcript = this.state.transcript): Promise<void> {
    const selection = this.selection;
    if (transcript === this.state.transcript) this.historyPinned = true;
    if (!transcript.ready || !transcript.hasMore || transcript.beforeSeq === undefined) return;
    const result = await this.host.call('session/page', { request: {
      address: { kind: 'session', sessionId: this.sessionId }, throughSeq: transcript.cursor,
      beforeSeq: transcript.beforeSeq, maxMessages: 80,
    } }, signal);
    if (selection !== this.selection) return;
    transcript.addPage(result);
    this.update({});
  }

  /** Search one page at a time, preserving only the first 200 matches and releasing temporary content.
   * @param query - Literal, case-insensitive text including folded reasoning.
   * @param signal - Cancels HTTP and processing without cancelling the agent.
   * @returns Newest-first bounded summaries and an explicit truncation flag.
   */
  async searchHistory(query: string, signal: AbortSignal): Promise<HistorySearch> {
    const source = this.state.transcript;
    if (!source.ready) throw new Error('Wait for the session snapshot');
    const sessionId = this.sessionId;
    const selection = this.selection;
    const throughSeq = source.readThrough;
    const needle = query.toLowerCase();
    const result: HistorySearch = { items: [], truncated: false };
    const scan = (transcript: Transcript): boolean => {
      const messages = transcript.messages;
      for (let index = messages.length - 1; index >= 0; index--) {
        signal.throwIfAborted();
        const message = messages[index]!;
        if (message.role === 'Tool') continue;
        const text = message.text;
        const match = text.toLowerCase().indexOf(needle);
        if (match < 0) continue;
        if (result.items.length === 200) { result.truncated = true; return false; }
        result.items.push({ seq: message.seq, role: message.role, preview: Buffer.from(toolLine(text.slice(Math.max(0, match - 40), match + needle.length + 100), 160)).toString('utf8') });
      }
      return true;
    };
    signal.throwIfAborted();
    if (!scan(source)) return result;
    let beforeSeq = source.beforeSeq;
    let hasMore = source.hasMore;
    while (hasMore && beforeSeq !== undefined) {
      const page = object(await this.host.call('session/page', { request: {
        address: { kind: 'session', sessionId }, throughSeq, beforeSeq, maxMessages: 80,
      } }, signal));
      signal.throwIfAborted();
      if (selection !== this.selection) throw new Error('Session changed while searching history');
      const temporary = new Transcript();
      try {
        temporary.accept({ type: 'snapshot', cursor: throughSeq, assistantStream: { revision: 0 }, records: page.records, hasMore: page.hasMore });
        const next = temporary.beforeSeq;
        if (temporary.hasMore && (next === undefined || next >= beforeSeq)) throw new Error('Host history page did not advance');
        if (!scan(temporary)) return result;
        beforeSeq = next; hasMore = temporary.hasMore;
      } finally { temporary.dispose(); }
    }
    return result;
  }

  /** Load a separate small window ending at a search target; the live transcript keeps following.
   * @param target - Durable message sequence to display.
   * @param signal - Cancels the target-page request.
   * @returns A caller-owned historical window that must be disposed when closed.
   */
  async historyAt(target: number, signal: AbortSignal): Promise<Transcript> {
    const source = this.state.transcript;
    const selection = this.selection;
    const page = object(await this.host.call('session/page', { request: {
      address: { kind: 'session', sessionId: this.sessionId }, throughSeq: source.readThrough,
      beforeSeq: target + 1, maxMessages: 80,
    } }, signal));
    signal.throwIfAborted();
    if (selection !== this.selection) throw new Error('Session changed while opening history');
    const window = new Transcript();
    try {
      window.accept({ type: 'snapshot', cursor: source.readThrough, assistantStream: { revision: 0 }, records: page.records, hasMore: page.hasMore });
      if (!window.messages.some(message => message.seq === target)) throw new Error('The host did not return the requested message');
      return window;
    } catch (error) { window.dispose(); throw error; }
  }

  /** Load the prefix required for an explicit history jump; never loop on an unadvancing page.
   * @param target - Visible record sequence, or first for the oldest available history.
   * @param signal - Cancels local paging without interrupting the remote agent.
   */
  async historyThrough(target: number | 'first', signal: AbortSignal): Promise<void> {
    const transcript = this.state.transcript;
    if (!transcript.ready) throw new Error('Wait for the session snapshot');
    while (transcript.hasMore && (target === 'first' || transcript.beforeSeq !== undefined && transcript.beforeSeq > target)) {
      signal.throwIfAborted();
      const before = transcript.beforeSeq;
      await this.older(signal);
      if (this.state.transcript !== transcript) throw new Error('Session changed while loading history');
      if (transcript.hasMore && (before === undefined || transcript.beforeSeq === undefined || transcript.beforeSeq >= before)) {
        throw new Error('Host history page did not advance');
      }
    }
  }

  /** Answer the oldest selected-session interaction, after explicit user action. */
  async answer(value: Json): Promise<void> {
    const pending = this.state.pending[0];
    if (!pending) throw new Error('No pending interaction');
    await this.reply(pending, { kind: 'result', value });
    this.interactions.delete(string(pending.eventId));
    this.update({});
  }

  /** Restrict an approval command to an approval request. */
  async approve(allowed: boolean): Promise<void> {
    if (this.state.pending[0]?.event !== 'approval/request') throw new Error('No pending approval');
    await this.answer(allowed ? 'allowed-once' : 'rejected');
  }

  /** Present only sessions explicitly accounted to the selected workspace. */
  get visibleSessions(): ObjectValue[] {
    const sessions = this.state.sessions.filter(item => !this.client?.archivedSessionIds.has(string(item.sessionId)));
    if (this.state.showAllSessions || !this.state.workspaceId) return sessions;
    const workspace = this.state.workspaces.find(item => item.workspaceId === this.state.workspaceId);
    const ids = new Set(array(workspace?.sessionIds ?? []).map(string));
    return sessions.filter(item => ids.has(string(item.sessionId)));
  }

  private get host(): Client {
    if (!this.client || !this.state.online) throw new Error('Not connected');
    return this.client;
  }
  private get sessionId(): string {
    if (!this.state.sessionId) throw new Error('Select a session first');
    return this.state.sessionId;
  }
  private update(patch: Partial<State>): void {
    const next = { ...this.state, ...patch, version: this.state.version + 1 };
    next.pending = next.online && next.screen === 'chat'
      ? [...this.interactions.values()].filter(frame => frame.agentId === next.sessionId) : [];
    this.state = next;
    for (const observer of this.observers) observer();
  }
  private async reply(frame: ObjectValue, outcome: ObjectValue): Promise<void> {
    await this.host.call('$events/result', { clientId: this.clientId, eventId: string(frame.eventId), outcome });
  }
  private refreshCatalog(client: Client): void {
    const revision = ++this.catalogRevision;
    const task = client.call('session/modelCatalog', {}).then(value => {
      if (client === this.client && revision === this.catalogRevision) this.update({ defaultModel: object(object(value).default), modelError: undefined });
    }, error => {
      if (client === this.client && revision === this.catalogRevision) this.update({ defaultModel: undefined, modelError: errorText(error) });
    }).catch(error => {
      if (client === this.client && revision === this.catalogRevision) this.update({ defaultModel: undefined, modelError: errorText(error) });
    });
    this.catalogTasks.add(task);
    void task.finally(() => this.catalogTasks.delete(task));
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      this.stoppingSession = undefined;
      this.runningUpdates.clear();
      this.observedRunningAt.clear();
      this.telemetry = new Telemetry();
      this.update({ controlError: undefined, modelError: undefined, defaultModel: undefined, presets: undefined, presetError: undefined });
      const client = this.makeClient();
      this.client = client;
      try {
        await this.authenticate(client);
        await client.connect();
        let fail!: (error: Error) => void;
        const disconnected = new Promise<Error>(resolve => { fail = resolve; });
        this.generationFailed = fail;
        const ready = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Host ready timed out')), client.timeoutMs);
          client.subscribe('$events', {}, {
            item: value => {
              const frame = object(value);
              if (frame.type === 'ready') {
                this.clientId = string(frame.clientId);
                clearTimeout(timer);
                resolve();
              } else if (frame.type === 'waterfall') {
                if (['approval/request', 'user-questions/request'].includes(string(frame.event))) {
                  this.interactions.set(string(frame.eventId), frame);
                  this.update({});
                } else {
                  void client.call('$events/result', { clientId: this.clientId,
                    eventId: string(frame.eventId), outcome: { kind: 'next' } }).catch(error => fail(new Error(errorText(error))));
                }
              } else if (frame.type === 'cancel') {
                this.interactions.delete(string(frame.eventId));
                this.update({});
              } else if (frame.type === 'emit' && frame.event === 'api-session/status') {
                const args = array(frame.args);
                const sessionId = string(args[0]);
                if (typeof args[1] !== 'boolean') throw new Error('Invalid session running state');
                if (args[1] && !this.runningUpdates.get(sessionId)) this.observedRunningAt.set(sessionId, Date.now());
                if (!args[1]) {
                  this.observedRunningAt.delete(sessionId);
                  if (this.stoppingSession === sessionId) this.stoppingSession = undefined;
                }
                this.runningUpdates.set(sessionId, args[1]);
                this.update({ sessions: this.state.sessions.map(row => row.sessionId === sessionId ? { ...row, running: args[1]! } : row),
                  ...(sessionId === this.state.sessionId ? { status: args[1] ? 'Running…' : 'Idle' } : {}) });
                if (!args[1] && this.costs && this.state.online) void this.refreshCosts();
              } else if (frame.type === 'emit' && ['llm/adapters-updated', 'settings/document-updated', 'credentials/reference-updated'].includes(String(frame.event))) {
                this.refreshCatalog(client);
              } else if (frame.type === 'emit' && frame.event === 'api-session/error') {
                const args = array(frame.args);
                if (args[0] === this.state.sessionId) this.update({ status: 'Agent error', error: errorText(args[1]) });
              }
            },
            end: error => { clearTimeout(timer); const reason = error ?? new Error('Event stream ended'); reject(reason); fail(reason); },
          });
        });
        await ready;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Session control baseline timed out')), client.timeoutMs);
          client.subscribe('session/control', {}, {
            item: value => {
              try {
                this.telemetry.accept(value);
                this.update({});
                clearTimeout(timer); resolve();
              } catch (error) { clearTimeout(timer); reject(error); fail(new Error(errorText(error))); }
            },
            end: error => {
              clearTimeout(timer);
              if (error instanceof RemoteError && error.code === 'gateway/method-unavailable') {
                this.update({ controlError: 'Live metrics unavailable on this host' }); resolve();
              } else { const reason = error ?? new Error('Session control stream ended'); reject(reason); fail(reason); }
            },
          });
        });
        this.refreshCatalog(client);
        this.update({ online: true, status: 'Connected', error: '', pending: [] });
        const screen = this.state.screen;
        await this.showPicker(screen === 'sessions' ? 'sessions' : 'workspaces');
        const sessionId = this.state.sessionId ?? this.initialSession;
        if (sessionId && (screen === 'chat' || this.initialSession && !this.state.sessionId)) await this.selectSession(sessionId);
        attempt = 0;
        if (this.costs) {
          void this.refreshCosts();
          clearInterval(this.costTimer);
          this.costTimer = setInterval(() => { if (this.state.online) void this.refreshCosts(); }, 60_000);
        }
        const error = await disconnected;
        if (!this.abort.signal.aborted) throw error;
      } catch (error) {
        if (error instanceof AuthenticationRequired || error instanceof HttpError && [401, 403].includes(error.status)) {
          this.update({ error: `${errorText(error)}. Set DSH_TOKEN and restart to log in.`, status: 'Login required' });
          return;
        }
        if (!this.abort.signal.aborted) this.update({ error: errorText(error), status: 'Reconnecting…' });
      } finally {
        clearInterval(this.costTimer);
        this.generationFailed = undefined;
        this.selection++;
        this.state.transcript.ready = false;
        this.interactions.clear();
        this.update({ online: false, pending: [] });
        await client.close();
        await this.costTask;
      }
      if (!this.abort.signal.aborted) {
        try { await delay(Math.min(500 * 2 ** attempt++, 10_000) * (0.8 + Math.random() * 0.4), undefined,
          { signal: this.abort.signal }); } catch (error) { if (!this.abort.signal.aborted) throw error; }
      }
    }
  }
}
