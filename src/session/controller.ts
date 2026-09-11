/** Session domain: selection, the follow stream, history, interaction and navigation. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Subscription } from '../transport/client.ts';
import type { HostAccess } from '../transport/host.ts';
import { array, errorText, object, string, type Json, type ObjectValue } from '../transport/wire.ts';
import type { ControllerStore, State } from '../state.ts';
import { saveSessionLog } from './export.ts';
import { releaseHistoryLayout } from './history.ts';
import type { HistoryLimits } from './memory.ts';
import { resolveTarget, sessionLabel } from './navigation.ts';
import { fileReferences, type FileReference } from './references.ts';
import { Transcript, toolLine } from './transcript.ts';
import type { ConnectionView } from './connection-view.ts';
import type { HistorySearch, RemovalTarget } from './types.ts';

/** Built-in preset identifiers and the labels the web session header shows. */
const BUILT_IN_MODES = new Map([['standard', 'Standard mode'], ['ptc', 'PTC mode'], ['minimal', 'Minimal mode'], ['cordis', 'Creator mode']]);

/** Bounded match count for one history search. */
const SEARCH_MATCH_LIMIT = 200;

/** Owns the selected session: its follow stream, transcript, history window and interactions. */
export class SessionController {
  private follow: Subscription | undefined;
  private interactions = new Map<string, ObjectValue>();
  private historyPinned = false;
  private stoppingSession?: string;
  private interruptTask: Promise<boolean> | undefined;
  private admission: Promise<Json | undefined> | undefined;
  constructor(private readonly store: ControllerStore, private readonly host: HostAccess,
    private readonly connection: ConnectionView, private readonly historyLimits: HistoryLimits) {}

  /** Host running state covers model generation, tools, and waits between assistant attempts. */
  get running(): boolean {
    const id = this.store.state.sessionId;
    return id !== undefined && (this.connection.runningFor(id)
      ?? this.store.state.sessions.find(row => row.sessionId === id)?.running === true);
  }

  /** Current title projection, falling back to the list title and then the session ID. */
  get sessionName(): string | undefined {
    const id = this.store.state.sessionId;
    if (!id) return;
    const title = this.connection.telemetryView().view(id).values.title;
    const row = this.store.state.sessions.find(item => item.sessionId === id);
    return title !== undefined ? sessionLabel({ sessionId: id, projections: { values: { title } } })
      : row ? sessionLabel(row) : id;
  }

  /** Current agent-preset name, matching the web header's built-in labels and custom metadata. */
  get sessionMode(): string | undefined {
    if (!this.store.state.sessionId) return undefined;
    const id = this.connection.telemetryView().view(this.store.state.sessionId).values.agentPreset;
    if (typeof id !== 'string') return undefined;
    const preset = this.store.state.presets?.find(item => item.id === id);
    return preset?.trust === 'system' && BUILT_IN_MODES.has(id) ? BUILT_IN_MODES.get(id)
      : typeof preset?.name === 'string' ? preset.name : id;
  }

  /** Epoch start from the retained turn log, or when this client first observed the run. */
  get workingSince(): number | undefined {
    if (!this.running || !this.store.state.sessionId) return undefined;
    return this.store.state.transcript.activeTurnStartedAt ?? this.connection.observedAt(this.store.state.sessionId);
  }

  /** Present only sessions explicitly accounted to the selected workspace. */
  get visibleSessions(): ObjectValue[] {
    const sessions = this.store.state.sessions.filter(item => !this.host.client()?.archivedSessionIds.has(string(item.sessionId)));
    if (this.store.state.showAllSessions || !this.store.state.workspaceId) return sessions;
    const workspace = this.store.state.workspaces.find(item => item.workspaceId === this.store.state.workspaceId);
    const ids = new Set(array(workspace?.sessionIds ?? []).map(string));
    return sessions.filter(item => ids.has(string(item.sessionId)));
  }

  /** Whether a turn, cancellation or prompt admission is still in flight. */
  get active(): boolean { return this.interruptTask !== undefined || this.running || this.admission !== undefined; }

  /** Whether reading protects the loaded window, suspending history reclamation. */
  get pinned(): boolean { return this.historyPinned; }

  /** Drop generation-scoped state before a new connection generation begins. */
  beginGeneration(): void { this.stoppingSession = undefined; }

  /** Invalidate in-flight work and drop transient interactions when a generation ends. */
  endGeneration(): void {
    this.store.bumpSelection();
    this.store.state.transcript.ready = false;
    this.interactions.clear();
  }

  /** Wait for an in-flight cancellation so shutdown leaves nothing running. */
  async settle(): Promise<void> { await this.interruptTask; }

  /** Release the selected transcript and its layout caches. */
  release(): void { this.releaseTranscript(); }

  /** Pending interactions for the selected chat session, derived independently of frame order.
   * @param state - State being published.
   * @returns Retained question and approval frames for that session.
   */
  pendingFor(state: State): ObjectValue[] {
    return [...this.interactions.values()].filter(frame => frame.agentId === state.sessionId);
  }

  /** Retain a recognized host waterfall; unknown events stay with the connection to delegate.
   * @param frame - One decoded waterfall frame.
   * @returns Whether this domain retained the frame for an answer.
   */
  waterfall(frame: ObjectValue): boolean {
    if (!['approval/request', 'user-questions/request'].includes(string(frame.event))) return false;
    this.interactions.set(string(frame.eventId), frame);
    this.store.update({});
    return true;
  }

  /** Drop a waterfall the host cancelled.
   * @param eventId - Correlation id previously retained.
   */
  cancelled(eventId: string): void { this.interactions.delete(eventId); this.store.update({}); }

  /** Apply one host running-state notification to the session list and status line.
   * @param sessionId - Session whose state changed.
   * @param running - Whether the host still runs that session.
   */
  status(sessionId: string, running: boolean): void {
    if (!running && this.stoppingSession === sessionId) this.stoppingSession = undefined;
    this.store.update({ sessions: this.store.state.sessions.map(row => row.sessionId === sessionId ? { ...row, running } : row),
      ...(sessionId === this.store.state.sessionId ? { status: running ? 'Running…' : 'Idle' } : {}) });
  }

  /** Surface a host-reported error for the selected session.
   * @param sessionId - Session the host reported on.
   * @param error - Error payload as delivered by the host.
   */
  reportError(sessionId: unknown, error: unknown): void {
    if (sessionId === this.store.state.sessionId) this.store.update({ status: 'Agent error', error: errorText(error) });
  }

  /** Stop the selected turn, or allow exit only while idle. Repeated keys share one request.
   * @param force - Send an explicit cancellation even when the cached running flag is idle.
   * @returns True when the caller may exit; cancellation failures retain the client.
   */
  interrupt(force = false): Promise<boolean> {
    if (this.interruptTask) return this.interruptTask;
    if (!force && !this.running && !this.admission && this.store.state.pending.length === 0) {
      return Promise.resolve(!this.store.state.busy);
    }
    const sessionId = this.sessionId;
    this.stoppingSession = sessionId;
    this.store.update({ status: 'Stopping…', error: '' });
    const task = (async () => {
      try {
        // Admission must settle before cancellation can address the newly submitted turn.
        // The prompt caller reports admission failures; an existing turn still needs cancellation.
        await this.admission?.catch(() => undefined);
        await this.host.require().call('session/cancel', { request: { sessionId } });
        if (this.stoppingSession === sessionId && this.store.state.sessionId === sessionId) this.store.update({ status: 'Cancellation requested · waiting for host' });
      } catch (error) { this.stoppingSession = undefined; this.store.update({ status: 'Cancellation failed', error: errorText(error) }); }
      return false;
    })();
    this.interruptTask = task;
    void task.finally(() => { this.interruptTask = undefined; });
    return task;
  }

  /** Keep history stable while the user reads, searches, or expands it; trim again at the live tail.
   * @param pinned - Whether the main transcript is actively being read away from its tail.
   */
  pinHistory(pinned: boolean): void {
    this.historyPinned = pinned;
    if (!pinned && this.reclaimHistory()) this.store.update({});
  }

  /** Cancel the active turn; pending queue items remain host-owned. */
  async cancelTurn(): Promise<void> {
    await this.host.require().call('session/cancel', { request: { sessionId: this.sessionId } });
    this.store.update({ status: 'Cancellation requested' });
  }

  /** Refresh both lists from the host, then show the requested picker.
   * @param screen - Picker to display after the refresh.
   */
  async showPicker(screen: 'workspaces' | 'sessions'): Promise<void> {
    const client = this.host.require();
    const [workspaces, sessions] = await Promise.all([client.listWorkspaces(), client.listSessions()]);
    this.store.update({ screen, workspaces, sessions });
  }

  /** Resolve a removal command to one reviewable object without changing the selection.
   * @param kind - Workspace registration removal or session archival.
   * @param query - Exact name, ID, or unambiguous ID prefix.
   * @returns The fixed identity and display details for confirmation.
   */
  async removalTarget(kind: 'workspace' | 'session', query: string): Promise<RemovalTarget> {
    const client = this.host.require();
    const items = kind === 'workspace' ? await client.listWorkspaces() : await client.listSessions();
    const row = resolveTarget(items, query, kind === 'workspace' ? 'workspaceId' : 'sessionId',
      item => kind === 'workspace' ? [string(item.title), string(item.path)] : [sessionLabel(item)]);
    return kind === 'workspace' ? { kind, id: string(row.workspaceId), name: string(row.title), path: string(row.path) }
      : { kind, id: string(row.sessionId), name: sessionLabel(row),
        empty: row.blank === true && row.running === false
          && !this.connection.runningFor(string(row.sessionId))
          && !(this.connection.telemetryView().view(string(row.sessionId)).queued ?? 0)
          && !(this.connection.telemetryView().view(string(row.sessionId)).jobs ?? 0)
          && !(this.store.state.sessionId === row.sessionId && this.admission) };
  }

  /** Apply a confirmed removal or freshly verified empty-session archival; directories and logs are preserved.
   * @param target - Exact workspace or session identity reviewed by the user.
   */
  async removeTarget(target: RemovalTarget): Promise<void> {
    const client = this.host.require();
    const receipt = object(await client.call(target.kind === 'workspace' ? 'workspace/delete' : 'workspace/archiveSession', {
      request: target.kind === 'workspace' ? { workspaceId: target.id } : { sessionId: target.id },
    }));
    if (client !== this.host.client()) return;
    if (target.kind === 'session') {
      client.archivedSessionIds = new Set(array(receipt.archivedSessionIds).map(string));
      if (this.store.state.sessionId === target.id) this.pickWorkspace(this.store.state.workspaceId);
    } else {
      if (receipt.deleted !== true) throw new Error('Host did not confirm workspace removal');
      this.store.update({ workspaces: this.store.state.workspaces.filter(row => row.workspaceId !== target.id),
        ...(this.store.state.workspaceId === target.id ? { workspaceId: undefined } : {}) });
    }
    this.store.update({ screen: target.kind === 'workspace' ? 'workspaces' : 'sessions',
      status: target.kind === 'workspace' ? 'Workspace registration removed' : 'Session archived' });
    // A refresh failure must not make a successful mutation look like a rejected deletion.
    try { await this.showPicker(target.kind === 'workspace' ? 'workspaces' : 'sessions'); }
    catch (error) { this.store.update({ error: `Removal completed; list refresh failed: ${errorText(error)}` }); }
  }

  /** Pick a workspace, or use all sessions when the identity is omitted.
   * @param workspaceId - Workspace to select, if any.
   */
  pickWorkspace(workspaceId?: string): void {
    this.store.bumpSelection();
    this.follow?.cancel(); this.follow = undefined;
    this.releaseTranscript();
    this.store.update({ workspaceId, sessionId: undefined, showAllSessions: false, transcript: new Transcript(), screen: 'sessions' });
  }

  /** Open a workspace picker, or resolve a workspace by ID, exact title/path, or unique ID prefix.
   * @param query - Workspace target, if any.
   */
  async switchWorkspace(query?: string): Promise<void> {
    if (!query) { await this.showPicker('workspaces'); return; }
    const client = this.host.require();
    const workspaces = await client.listWorkspaces();
    const workspace = resolveTarget(workspaces, query, 'workspaceId', item => [string(item.title), string(item.path)]);
    const sessions = await client.listSessions();
    this.store.update({ workspaces, sessions });
    this.pickWorkspace(string(workspace.workspaceId));
  }

  /** Guide workspace selection, list all sessions with `all`, or resolve an exact session target.
   * @param query - Session target, `all`, or nothing for the guided picker.
   */
  async switchSession(query?: string): Promise<void> {
    if (!query || query === 'all') {
      await this.showPicker(query === 'all' || this.store.state.workspaceId ? 'sessions' : 'workspaces');
      this.store.update({ showAllSessions: query === 'all' });
      return;
    }
    const client = this.host.require();
    const [workspaces, sessions] = await Promise.all([client.listWorkspaces(), client.listSessions()]);
    const session = resolveTarget(sessions, query, 'sessionId', item => [sessionLabel(item)]);
    this.store.update({ workspaces, sessions });
    await this.selectSession(string(session.sessionId));
  }

  /** Prompt for a host path without starting a local agent. */
  enterPath(): void { this.store.update({ screen: 'path' }); }

  /** Register a host directory and move to its session picker.
   * @param path - Absolute directory path on the host.
   */
  async createWorkspace(path: string): Promise<void> {
    const result = object(await this.host.require().call('workspace/create', { request: { path } }));
    const workspace = object(result.workspace);
    await this.showPicker('workspaces');
    this.pickWorkspace(string(workspace.workspaceId));
  }

  /** Create a session only after the user explicitly selects New session. */
  async createSession(): Promise<void> {
    if (!this.store.state.workspaceId) throw new Error('Select a workspace before creating a session');
    const result = object(await this.host.require().call('session/create', { request: { workspaceId: this.store.state.workspaceId } }));
    await this.selectSession(string(result.sessionId));
  }

  /** Replace the selected transcript and cancel its preceding follow stream.
   * @param sessionId - Session to follow.
   */
  async selectSession(sessionId: string): Promise<void> {
    this.stoppingSession = undefined;
    this.store.bumpSelection();
    const selection = this.store.selection();
    this.follow?.cancel(); this.follow = undefined;
    this.releaseTranscript();
    const transcript = new Transcript();
    const workspace = this.store.state.workspaces.find(item => array(item.sessionIds).includes(sessionId));
    const workspaceId = workspace ? string(workspace.workspaceId)
      : this.store.state.sessions.some(item => item.sessionId === sessionId) ? undefined : this.store.state.workspaceId;
    this.connection.observe(sessionId);
    this.store.update({ sessionId, workspaceId, showAllSessions: false, transcript, screen: 'chat', status: 'Loading session…' });
    this.follow = this.host.require().subscribe('session/follow', {
      request: { address: { kind: 'session', sessionId }, maxMessages: 80, assistantStream: true },
    }, {
      item: value => {
        if (selection !== this.store.selection()) return;
        try {
          transcript.accept(value);
          this.reclaimHistory();
          const frame = object(value);
          if (frame.type === 'snapshot') this.connection.telemetryView().snapshot(sessionId, frame.projections);
          this.store.update({ transcript, status: this.stoppingSession === sessionId ? this.store.state.status : transcript.hasLiveContent ? 'Responding…' : 'Connected' });
        } catch (error) { this.connection.fail(new Error(errorText(error))); }
      },
      end: error => {
        if (selection !== this.store.selection()) return;
        transcript.ready = false;
        this.store.update({ status: 'Session disconnected', error: errorText(error ?? 'Session stream ended') });
      },
    });
  }

  /** Wait for the selected follow snapshot, failing on disconnect or cancellation.
   * @param signal - Cancels waiting without closing the session.
   */
  async waitForHistory(signal: AbortSignal): Promise<void> {
    const transcript = this.store.state.transcript;
    const deadline = Date.now() + this.host.require().timeoutMs;
    while (!transcript.ready) {
      signal.throwIfAborted();
      if (!this.store.state.online || this.store.state.transcript !== transcript) throw new Error('Session changed while loading history');
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
    const workspace = this.store.state.workspaces.find(item => item.workspaceId === this.store.state.workspaceId);
    if (workspaceOnly && !workspace) throw new Error('Select a workspace first');
    const result = object(await this.host.require().call('session/search', { request: { query } }, signal));
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
    return fileReferences(await this.host.require().call('fileReferences/list', { agentId: this.sessionId, query }, signal));
  }

  /** Execute a human command directly, outside the model prompt queue.
   * @param line - Complete slash command, including arguments.
   * @param signal - Cancels the request while the host performs compaction.
   * @returns The host's successful command result text.
   */
  async command(line: string, signal: AbortSignal): Promise<string> {
    if (!this.store.state.transcript.ready) throw new Error('Wait for the session snapshot before running commands');
    const execution = await this.host.require().call('commands/execute', {
      agentId: this.sessionId, line, submittedAttachments: [],
    }, signal, null);
    if (execution === undefined) throw new Error(`This host does not provide ${line.split(/\s/, 1)[0]}`);
    const result = object(object(execution).result);
    if ((result.kind !== 'success' && result.kind !== 'error') || (result.text !== undefined && typeof result.text !== 'string')) {
      throw new Error('Invalid command result from host');
    }
    if (result.kind === 'error') throw new Error(string(result.text));
    return result.text === undefined ? 'Command completed.' : string(result.text);
  }

  /** Remove one host-owned pending input; an already claimed item reports a host error.
   * @param itemId - Queue occurrence identity from session/control.
   */
  async removeQueued(itemId: string): Promise<void> {
    await this.host.require().call('session/updateQueue', { request: { sessionId: this.sessionId, itemId, action: { kind: 'remove' } } });
  }

  /** Export the selected host log to a new local ZIP file.
   * @param path - Optional local destination; existing files are never overwritten.
   * @param signal - Cancels the download and removes an incomplete file.
   * @returns Absolute saved filename.
   */
  async exportLog(path: string | undefined, signal: AbortSignal): Promise<string> {
    return saveSessionLog(this.host.require(), this.sessionId, path, signal);
  }

  /** Admit text once as steering while running, or a new turn while idle; a lost response can leave delivery uncertain.
   * @param text - Composed prompt text.
   */
  async prompt(text: string): Promise<void> {
    if (this.store.state.pending.length) throw new Error('Answer the pending question or approval first');
    this.stoppingSession = undefined;
    if (!this.store.state.transcript.ready) throw new Error('Wait for the session snapshot before sending');
    const admission = this.host.require().call('session/prompt', { request: {
      sessionId: this.sessionId, requestId: randomUUID(), mode: this.running ? 'steer' : 'queue',
      content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } });
    this.admission = admission;
    try { await admission; } finally { if (this.admission === admission) this.admission = undefined; }
    this.store.update({ status: 'Accepted · waiting for host' });
  }

  /** Answer the oldest selected-session interaction, after explicit user action.
   * @param value - Structured answer value or approval outcome.
   */
  async answer(value: Json): Promise<void> {
    const pending = this.store.state.pending[0];
    if (!pending) throw new Error('No pending interaction');
    await this.reply(pending, { kind: 'result', value });
    this.interactions.delete(string(pending.eventId));
    this.store.update({});
  }

  /** Restrict an approval command to an approval request.
   * @param allowed - Whether the request is approved once.
   */
  async approve(allowed: boolean): Promise<void> {
    if (this.store.state.pending[0]?.event !== 'approval/request') throw new Error('No pending approval');
    await this.answer(allowed ? 'allowed-once' : 'rejected');
  }

  /** Add a page before the retained window using its fixed opening cut.
   * @param signal - Cancels local paging without interrupting the remote agent.
   * @param transcript - Transcript to extend; defaults to the live one.
   */
  async older(signal?: AbortSignal, transcript = this.store.state.transcript): Promise<void> {
    const selection = this.store.selection();
    if (transcript === this.store.state.transcript) this.historyPinned = true;
    if (!transcript.ready || !transcript.hasMore || transcript.beforeSeq === undefined) return;
    const result = await this.host.require().call('session/page', { request: {
      address: { kind: 'session', sessionId: this.sessionId }, throughSeq: transcript.cursor,
      beforeSeq: transcript.beforeSeq, maxMessages: 80,
    } }, signal);
    if (selection !== this.store.selection()) return;
    transcript.addPage(result);
    this.store.update({});
  }

  /** Search one page at a time, preserving only the first 200 matches and releasing temporary content.
   * @param query - Literal, case-insensitive text including folded reasoning.
   * @param signal - Cancels HTTP and processing without cancelling the agent.
   * @returns Newest-first bounded summaries and an explicit truncation flag.
   */
  async searchHistory(query: string, signal: AbortSignal): Promise<HistorySearch> {
    const source = this.store.state.transcript;
    if (!source.ready) throw new Error('Wait for the session snapshot');
    const sessionId = this.sessionId;
    const selection = this.store.selection();
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
        if (result.items.length === SEARCH_MATCH_LIMIT) { result.truncated = true; return false; }
        result.items.push({ seq: message.seq, role: message.role, preview: Buffer.from(toolLine(text.slice(Math.max(0, match - 40), match + needle.length + 100), 160)).toString('utf8') });
      }
      return true;
    };
    signal.throwIfAborted();
    if (!scan(source)) return result;
    let beforeSeq = source.beforeSeq;
    let hasMore = source.hasMore;
    while (hasMore && beforeSeq !== undefined) {
      const page = object(await this.host.require().call('session/page', { request: {
        address: { kind: 'session', sessionId }, throughSeq, beforeSeq, maxMessages: 80,
      } }, signal));
      signal.throwIfAborted();
      if (selection !== this.store.selection()) throw new Error('Session changed while searching history');
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
    const source = this.store.state.transcript;
    const selection = this.store.selection();
    const page = object(await this.host.require().call('session/page', { request: {
      address: { kind: 'session', sessionId: this.sessionId }, throughSeq: source.readThrough,
      beforeSeq: target + 1, maxMessages: 80,
    } }, signal));
    signal.throwIfAborted();
    if (selection !== this.store.selection()) throw new Error('Session changed while opening history');
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
    const transcript = this.store.state.transcript;
    if (!transcript.ready) throw new Error('Wait for the session snapshot');
    while (transcript.hasMore && (target === 'first' || transcript.beforeSeq !== undefined && transcript.beforeSeq > target)) {
      signal.throwIfAborted();
      const before = transcript.beforeSeq;
      await this.older(signal);
      if (this.store.state.transcript !== transcript) throw new Error('Session changed while loading history');
      if (transcript.hasMore && (before === undefined || transcript.beforeSeq === undefined || transcript.beforeSeq >= before)) {
        throw new Error('Host history page did not advance');
      }
    }
  }

  /** Reclaim reloadable history unless the user is reading away from the tail.
   * @returns Number of removed records.
   */
  private reclaimHistory(): number {
    if (this.historyPinned || !this.store.state.online) return 0;
    const removed = this.store.state.transcript.trimHistory(this.historyLimits);
    if (removed) releaseHistoryLayout(this.store.state.transcript);
    return removed;
  }

  /** Release the selected transcript and its layout caches. */
  private releaseTranscript(): void {
    releaseHistoryLayout(this.store.state.transcript);
    this.store.state.transcript.dispose(); this.historyPinned = false;
  }

  /** @returns The selected session identity, or a `Select a session first` failure. */
  private get sessionId(): string {
    if (!this.store.state.sessionId) throw new Error('Select a session first');
    return this.store.state.sessionId;
  }

  /** Answer one retained waterfall through the connection's event-result endpoint. */
  private async reply(frame: ObjectValue, outcome: ObjectValue): Promise<void> {
    await this.connection.reply(frame, outcome);
  }
}
