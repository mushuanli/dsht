/** Session domain: selection, the follow stream, history, interaction and navigation. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Subscription } from '../transport/client.ts';
import type { HostAccess } from '../transport/host.ts';
import { array, errorText, object, string, type Json, type ObjectValue } from '../transport/wire.ts';
import type { ControllerStore, State } from '../state.ts';
import { saveSessionLog } from './export.ts';
import { saveTranscriptHtml } from './export-html.ts';
import { releaseHistoryLayout } from './history.ts';
import type { HistoryLimits } from './memory.ts';
import { resolveTarget, sessionLabel } from './navigation.ts';
import { fileReferences, type FileReference } from './references.ts';
import { PromptCache, type ComposerState, type InteractionState, type ModelState, type OptionState, type PanelState, type PromptIndex, type ReferenceState, type SessionInfo, type ViewState } from './info.ts';
import type { Reasoning } from './history.ts';
import { recordPrompts, Transcript, toolLine } from './transcript.ts';
import type { ConnectionView } from './connection-view.ts';
import type { HistorySearch, RemovalTarget } from './types.ts';

/** Built-in preset identifiers and the labels the web session header shows. */
const BUILT_IN_MODES = new Map([['standard', 'Standard mode'], ['ptc', 'PTC mode'], ['minimal', 'Minimal mode'], ['cordis', 'Creator mode']]);

/** Bounded match count for one history search. */
const SEARCH_MATCH_LIMIT = 200;

/** Bounded page count for the prompt backfill that runs once per opened session. */
const PROMPT_BACKFILL_PAGES = 200;

/** Owns the selected session: its follow stream, transcript, history window and interactions. */
export class SessionController {
  private follow: Subscription | undefined;
  private interactions = new Map<string, ObjectValue>();
  /** Cancels the background prompt backfill of the previous selection. */
  private promptBackfill?: AbortController;
  /** Prompts of sessions this process has already read, so re-opening one costs no page request. */
  private readonly promptCache = new PromptCache();
  /** Prompt index, composer and reading view of the selected session; the instance `State.session` exposes. */
  private get info(): SessionInfo { return this.store.state.session; }
  private get prompts(): PromptIndex { return this.info.prompts; }
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
    return this.info.record.activeTurnStartedAt ?? this.connection.observedAt(this.store.state.sessionId);
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
  get pinned(): boolean { return this.info.view.pinned; }

  /** Drop generation-scoped state before a new connection generation begins. */
  beginGeneration(): void { this.stoppingSession = undefined; }

  /** Invalidate in-flight work and drop transient interactions when a generation ends. */
  endGeneration(): void {
    this.store.bumpSelection();
    this.info.record.ready = false;
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

  /** Unanswered interactions by session, so a list can show who is waiting without opening them.
   *
   * The host delivers approval and question waterfalls for every session on one stream, and this
   * client already retains them to answer later, so the counts are a fact of this generation rather
   * than a new subscription. They live only as long as the connection: a reconnect clears the map
   * until the host replays the pending waterfalls.
   * @returns One count per session holding at least one unanswered interaction.
   */
  pendingCounts(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const frame of this.interactions.values()) {
      if (typeof frame.agentId !== 'string') continue;
      counts.set(frame.agentId, (counts.get(frame.agentId) ?? 0) + 1);
    }
    return counts;
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
    this.info.view.pinned = pinned;
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
    this.store.update({ workspaceId, sessionId: undefined, showAllSessions: false, screen: 'sessions' });
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

  /** Adopt the workspace whose registered path contains the directory this client runs in.
   *
   * Longest path wins, so a workspace nested in another is preferred, and the comparison is on whole
   * path segments so `/srv/app-old` cannot match `/srv/app`. A remote host's paths usually differ
   * from the client's, in which case nothing matches and the picker stays exactly as before.
   * @param directory - Directory this client was started in.
   * @returns The adopted workspace's id, or undefined when none matches.
   */
  adoptLocalWorkspace(directory: string): string | undefined {
    const slashed = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const target = slashed(directory);
    if (target === '') return undefined;
    let best: { id: string; length: number } | undefined;
    for (const workspace of this.store.state.workspaces) {
      const path = slashed(string(workspace.path));
      if (path === '' || (target !== path && !target.startsWith(`${path}/`))) continue;
      if (best === undefined || path.length > best.length) best = { id: string(workspace.workspaceId), length: path.length };
    }
    if (best === undefined) return undefined;
    this.pickWorkspace(best.id);
    return best.id;
  }

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
    this.info.reset(sessionId);
    const transcript = this.info.record;
    const workspace = this.store.state.workspaces.find(item => array(item.sessionIds).includes(sessionId));
    const workspaceId = workspace ? string(workspace.workspaceId)
      : this.store.state.sessions.some(item => item.sessionId === sessionId) ? undefined : this.store.state.workspaceId;
    this.connection.observe(sessionId);
    this.store.update({ sessionId, workspaceId, showAllSessions: false, screen: 'chat', status: 'Loading session…' });
    this.follow = this.host.require().subscribe('session/follow', {
      request: { address: { kind: 'session', sessionId }, maxMessages: 80, assistantStream: true },
    }, {
      item: value => {
        if (selection !== this.store.selection()) return;
        try {
          transcript.accept(value);
          this.prompts.fold(transcript.promptsSince(this.prompts.through));
          this.reclaimHistory();
          const frame = object(value);
          if (frame.type === 'snapshot') this.connection.telemetryView().snapshot(sessionId, frame.projections);
          this.store.update({ status: this.stoppingSession === sessionId ? this.store.state.status : transcript.hasLiveContent ? 'Responding…' : 'Connected' });
        } catch (error) { this.connection.fail(new Error(errorText(error))); }
      },
      end: error => {
        if (selection !== this.store.selection()) return;
        transcript.ready = false;
        this.store.update({ status: 'Session disconnected', error: errorText(error ?? 'Session stream ended') });
      },
    });
    this.backfillPrompts(sessionId, selection);
  }

  /** Wait for the selected follow snapshot, failing on disconnect or cancellation.
   * @param signal - Cancels waiting without closing the session.
   */
  async waitForHistory(signal: AbortSignal): Promise<void> {
    const transcript = this.info.record;
    const deadline = Date.now() + this.host.require().timeoutMs;
    while (!transcript.ready) {
      signal.throwIfAborted();
      if (!this.store.state.online || this.info.record !== transcript) throw new Error('Session changed while loading history');
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
    if (!this.info.record.ready) throw new Error('Wait for the session snapshot before running commands');
    const execution = await this.host.require().call('commands/execute', {
      agentId: this.sessionId, line, submittedAttachments: [],
    }, signal, null);
    if (execution === undefined) throw new Error(`This host does not provide ${line.split(/\s/, 1)[0]}`);
    const result = object(object(execution).result);
    if ((result.kind !== 'success' && result.kind !== 'error') || (result.text !== undefined && typeof result.text !== 'string')) {
      throw new Error('Invalid command result from host');
    }
    if (result.kind === 'error') throw new Error(string(result.text));
    // Compaction rewrites the host log, so a cached prompt list for this session may describe
    // records that no longer exist. The live index keeps what the reader already sees; the cache is
    // dropped so the next open reads the rewritten history.
    if (line.trim().split(/\s/, 1)[0] === '/compact') this.promptCache.drop(this.sessionId);
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

  /** Save the retained conversation with offline Markdown, diagrams and math.
   * @param path - Optional destination; existing files are never overwritten.
   * @param signal - Cancels the write.
   * @returns Absolute saved filename.
   */
  async exportHtml(path: string | undefined, signal: AbortSignal): Promise<string> {
    return saveTranscriptHtml(this.info.record, this.sessionId, path, signal);
  }

  /** Admit text once as steering while running, or a new turn while idle; a lost response can leave delivery uncertain.
   * @param text - Composed prompt text.
   */
  async prompt(text: string): Promise<void> {
    if (this.store.state.pending.length) throw new Error('Answer the pending question or approval first');
    this.stoppingSession = undefined;
    if (!this.info.record.ready) throw new Error('Wait for the session snapshot before sending');
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

  /** Dismiss the whole selected-session question set without answering it.
   *
   * The Web client's close button settles the same waterfall the same way — reject with
   * `ASK_CANCELLED` — so the host records a user cancellation rather than an answer. A question
   * batch is answered as one request, so dismissals also discard partial local answers.
   */
  async dismissQuestion(): Promise<void> {
    const pending = this.store.state.pending[0];
    if (pending?.event !== 'user-questions/request') throw new Error('No pending question');
    await this.reply(pending, { kind: 'rejected', error: {
      name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED',
    } });
    this.interactions.delete(string(pending.eventId));
    this.store.update({});
  }

  /** Add a page before the retained window using its fixed opening cut.
   *
   * Reclamation is deliberately not pinned here. Every caller that needs the fetched page to
   * survive is already covered by the view: scrolling back sets a scroll position, `/think` opens a
   * panel, and a recall page folds its prompts into the index before this resolves. A pin set here
   * had no clearing edge, so after one recall page the history budget silently stopped applying for
   * the rest of the session while every following page kept adding records.
   * @param signal - Cancels local paging without interrupting the remote agent.
   * @param transcript - Transcript to extend; defaults to the live one.
   */
  async older(signal?: AbortSignal, transcript = this.info.record): Promise<void> {
    const selection = this.store.selection();
    if (!transcript.ready || !transcript.hasMore || transcript.beforeSeq === undefined) return;
    const result = await this.host.require().call('session/page', { request: {
      address: { kind: 'session', sessionId: this.sessionId }, throughSeq: transcript.cursor,
      beforeSeq: transcript.beforeSeq, maxMessages: 80,
    } }, signal);
    if (selection !== this.store.selection()) return;
    transcript.addPage(result);
    this.store.update({});
  }

  /** Recall one step through the session's prompt index; navigation never touches the network.
   * @param direction - Negative for older input, positive for newer input.
   * @param current - Composer content before recall began, restored at the newest position.
   * @returns The recalled prompt, or the unsent draft.
   */
  recall(direction: -1 | 1, current: string): string { return this.prompts.move(direction, current); }

  /** Composer draft, caret and parked draft, as the selected session holds them. */
  get composer(): ComposerState { return this.info.composer; }

  /** Replace the composer text and caret, publishing only when either actually changed. */
  setComposer(draft: string, cursor = draft.length): void {
    const composer = this.info.composer;
    if (composer.draft === draft && composer.cursor === cursor) return;
    composer.draft = draft; composer.cursor = cursor;
    this.store.update({});
  }

  /** Move the caret without changing the text. */
  setComposerCursor(cursor: number): void {
    const composer = this.info.composer;
    if (composer.cursor === cursor) return;
    composer.cursor = cursor;
    this.store.update({});
  }

  /** Move a non-empty draft aside while a dialog owns the keyboard. */
  parkComposer(): void {
    const composer = this.info.composer;
    if (composer.draft === '') return;
    composer.parked = composer.draft; composer.draft = ''; composer.cursor = 0;
    this.store.update({});
  }

  /** Give a parked draft back once no dialog needs the keyboard. */
  restoreComposer(): void {
    const composer = this.info.composer;
    if (composer.parked === '') return;
    composer.draft = composer.parked; composer.cursor = composer.parked.length; composer.parked = '';
    this.store.update({});
  }

  /** How the selected session's record is being read right now. */
  get view(): ViewState { return this.info.view; }

  /** Show a detached history window, releasing the one it replaces.
   * @param window - Record to display, or undefined to return to the live transcript.
   */
  setViewWindow(window?: Transcript): void {
    if (this.info.view.window === window) return;
    this.info.closeWindow();
    this.info.view.window = window;
    this.store.update({});
  }

  /** Move the reader's position inside the displayed record.
   * @param scroll - Rows scrolled back from the live end.
   */
  setScroll(scroll: number): void {
    if (this.info.view.scroll === scroll) return;
    this.info.view.scroll = scroll;
    this.store.update({});
  }

  /** Replace the set of expanded reasoning blocks, keyed by message sequence.
   * @param folds - Sequences to expand beyond the default fold.
   */
  setFolds(folds: ReadonlySet<number>): void {
    if (this.info.view.folds === folds) return;
    this.info.view.folds = folds;
    this.store.update({});
  }

  /** Set the fold mode of the live attempt's completed reasoning.
   * @param reasoning - `row` to fold, `full` to keep the streamed text.
   */
  setLiveReasoning(reasoning: Reasoning): void {
    if (this.info.view.liveReasoning === reasoning) return;
    this.info.view.liveReasoning = reasoning;
    this.store.update({});
  }

  /** Local answer state for the selected session's pending waterfalls. */
  get interaction(): InteractionState { return this.info.interaction; }

  /** Replace the partly collected answers, keyed by the waterfall event id.
   * @param answers - Answers collected so far, by event id.
   */
  setAnswers(answers: Record<string, ObjectValue[]>): void {
    this.info.interaction.answers = answers;
    this.store.update({});
  }

  /** Replace the pending question's option keyboard state.
   * @param option - Highlighted option, toggled labels and free-text mode; undefined clears it.
   */
  setOption(option?: OptionState): void {
    if (this.info.interaction.option === option) return;
    this.info.interaction.option = option;
    this.store.update({});
  }

  /** Replace the pending approval's selected row.
   * @param approval - Selected approval row; undefined clears the highlight.
   */
  setApproval(approval?: InteractionState['approval']): void {
    if (this.info.interaction.approval === approval) return;
    this.info.interaction.approval = approval;
    this.store.update({});
  }

  /** Composer-adjacent `@` reference menu state. */
  get reference(): ReferenceState { return this.info.reference; }

  /** Highlight one row of the open reference menu.
   * @param index - Row index into the current matches.
   */
  setReferenceIndex(index: number): void {
    if (this.info.reference.index === index) return;
    this.info.reference.index = index;
    this.store.update({});
  }

  /** Remember the draft that dismissed the reference menu, so it does not reopen while it stands.
   * @param draft - Composer text at dismissal, or undefined to allow the menu again.
   */
  setReferenceDismissed(draft?: string): void {
    if (this.info.reference.dismissed === draft) return;
    this.info.reference.dismissed = draft;
    this.store.update({});
  }

  /** Panels the selected session has open. */
  get panels(): PanelState { return this.info.panels; }

  /** Show or hide the reasoning panel.
   * @param open - Whether `/think` is open.
   */
  openThoughts(open: boolean): void {
    if (this.info.panels.thoughts === open) return;
    this.info.panels.thoughts = open;
    this.store.update({});
  }

  /** Show or hide the pending-input panel.
   * @param open - Whether `/queue` is open.
   */
  openQueue(open: boolean): void {
    if (this.info.panels.queue === open) return;
    this.info.panels.queue = open;
    this.store.update({});
  }

  /** Show the model dialog at one step, or close it.
   * @param model - Catalog plus the provider or model being inspected; undefined closes the dialog.
   */
  setModelPanel(model?: ModelState): void {
    if (this.info.panels.model === model) return;
    this.info.panels.model = model;
    this.store.update({});
  }

  /** Show the history or content-search dialog, or close it.
   * @param history - Query, content-search mode and matches; undefined closes the dialog.
   */
  setHistoryPanel(history?: PanelState['history']): void {
    if (this.info.panels.history === history) return;
    this.info.panels.history = history;
    this.store.update({});
  }

  /** Show the host session-search results, or close them.
   * @param search - Query, results and truncation flag; undefined closes the dialog.
   */
  setSearchPanel(search?: PanelState['search']): void {
    if (this.info.panels.search === search) return;
    this.info.panels.search = search;
    this.store.update({});
  }

  /** Remember a locally submitted command, which never becomes a durable session record. */
  recordRecall(value: string): void { this.prompts.record(value); }

  /** Leave recall navigation because the composer was edited or replaced. */
  resetRecall(): void { this.prompts.resetCursor(); }

  /** Whether recall is parked on the oldest prompt it retains in memory. */
  get recallAtOldest(): boolean { return this.prompts.atOldest; }

  /** How many prompts the session retains for recall. */
  get recallLength(): number { return this.prompts.length; }

  /** Whether an older prompt is reachable at all: shed from the window, or still on the host. */
  get recallHasOlder(): boolean {
    const transcript = this.info.record;
    const oldest = this.prompts.oldest;
    const refillable = oldest !== undefined && transcript.beforeSeq !== undefined && oldest > transcript.beforeSeq;
    return refillable || (!this.prompts.exhausted && transcript.hasMore);
  }

  /** Recover older prompts from the loaded window before spending a page request.
   *
   * The transcript window can still hold prompts the index's budgets evicted, so a backward step
   * refills from memory first and only then asks the caller to page. That is what keeps recall
   * complete across submissions, where the previous buffer lost them at the eviction boundary.
   * @returns Whether any older prompt was recovered.
   */
  refillRecall(): boolean {
    const oldest = this.prompts.oldest;
    if (oldest === undefined) return false;
    return this.prompts.prepend(this.info.record.promptsBefore(oldest)) > 0;
  }

  /** Seed recall from a complete cached entry, so an open that follows a scan costs no request.
   * @param sessionId - Session being opened.
   * @returns Whether the cache covered this session.
   */
  private adoptCachedPrompts(sessionId: string): boolean {
    const cached = this.promptCache.get(sessionId);
    if (!cached?.complete) return false;
    const oldest = this.prompts.oldest;
    const older = oldest === undefined ? cached.prompts : cached.prompts.filter(prompt => prompt.seq < oldest);
    this.prompts.prepend(older);
    // Same budget as the walk it replaces: `settle` may shed the oldest prefix, and `markComplete`
    // then refuses, so the lazy backward step stays available for whatever was shed.
    this.prompts.settle();
    this.prompts.markComplete();
    this.store.update({});
    return true;
  }

  /** Fold one history page the cost scan already read into the prompt cache.
   *
   * The scan reads every session's whole history on connect, so this is where two readers stop
   * paying twice: it hands over pages it already has, and an open that follows reads the cache.
   * @param sessionId - Session the page belongs to.
   * @param records - Raw records of one scanned page.
   */
  rememberScanPage(sessionId: string, records: readonly Json[]): void {
    this.promptCache.observe(sessionId, recordPrompts(records), false);
  }

  /** Report that the scanned session's history was read to its beginning.
   * @param sessionId - Session the scan finished.
   */
  rememberScanDone(sessionId: string): void {
    this.promptCache.observe(sessionId, [], true);
  }

  /** Fold every prompt the host still holds into the recall index, in the background.
   *
   * Session start delivers only the newest window, so without this the arrows could reach older
   * prompts but not show them without paging first. Each page is parsed into a temporary transcript
   * and only its prompts are kept, so the live record, its memory window and the row cache never
   * grow. The walk is bounded and the next selection cancels it; anything past the bound is still
   * reachable through the lazy backward step.
   * @param sessionId - Session being opened.
   * @param selection - Selector generation that must still be current.
   */
  private backfillPrompts(sessionId: string, selection: number): void {
    this.promptBackfill?.abort();
    const abort = new AbortController();
    this.promptBackfill = abort;
    void (async () => {
      try {
        while (!this.info.record.ready) {
          abort.signal.throwIfAborted();
          await delay(20, undefined, { signal: abort.signal });
        }
        // A cost scan or an earlier open may already have this session's prompts cached.
        if (this.adoptCachedPrompts(sessionId)) return;
        const throughSeq = this.info.record.readThrough;
        let beforeSeq = this.info.record.beforeSeq;
        let hasMore = this.info.record.hasMore;
        for (let page = 0; hasMore && beforeSeq !== undefined && page < PROMPT_BACKFILL_PAGES; page++) {
          abort.signal.throwIfAborted();
          if (selection !== this.store.selection()) return;
          const result = object(await this.host.require().call('session/page', { request: {
            address: { kind: 'session', sessionId }, throughSeq, beforeSeq, maxMessages: 80,
          } }, abort.signal));
          abort.signal.throwIfAborted();
          if (selection !== this.store.selection()) return;
          const temporary = new Transcript();
          try {
            temporary.accept({ type: 'snapshot', cursor: throughSeq, assistantStream: { revision: 0 }, records: result.records, hasMore: result.hasMore });
            const next = temporary.beforeSeq;
            if (temporary.hasMore && (next === undefined || next >= beforeSeq)) throw new Error('Host history page did not advance');
            this.prompts.prepend(temporary.promptsSince(-1).prompts);
            beforeSeq = next; hasMore = temporary.hasMore;
          } finally { temporary.dispose(); }
          // A scan that finished while this walk ran already established the same list.
          if (this.adoptCachedPrompts(sessionId)) return;
        }
        this.prompts.settle();
        // Only a walk that ended because the host said "no more" makes the index exhaustive; one
        // stopped by the page bound leaves the lazy backward step in charge of the rest.
        if (!hasMore) this.prompts.markComplete();
        // Cache only what the walk established: advertising a capped or shed list would let a later
        // open skip a fetch it still needs.
        if (!hasMore) this.promptCache.put(sessionId, { prompts: this.prompts.durableItems, complete: this.prompts.exhausted });
        this.store.update({});
      } catch {
        // A cancelled, disconnected or unavailable history leaves the lazy backward step in charge.
      } finally { if (this.promptBackfill === abort) this.promptBackfill = undefined; }
    })();
  }

  /** Search one page at a time, preserving only the first 200 matches and releasing temporary content.
   * @param query - Literal, case-insensitive text including folded reasoning.
   * @param signal - Cancels HTTP and processing without cancelling the agent.
   * @returns Newest-first bounded summaries and an explicit truncation flag.
   */
  async searchHistory(query: string, signal: AbortSignal): Promise<HistorySearch> {
    const source = this.info.record;
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
    const source = this.info.record;
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
    const transcript = this.info.record;
    if (!transcript.ready) throw new Error('Wait for the session snapshot');
    while (transcript.hasMore && (target === 'first' || transcript.beforeSeq !== undefined && transcript.beforeSeq > target)) {
      signal.throwIfAborted();
      const before = transcript.beforeSeq;
      await this.older(signal);
      if (this.info.record !== transcript) throw new Error('Session changed while loading history');
      if (transcript.hasMore && (before === undefined || transcript.beforeSeq === undefined || transcript.beforeSeq >= before)) {
        throw new Error('Host history page did not advance');
      }
    }
  }

  /** Reclaim reloadable history unless the user is reading away from the tail.
   * @returns Number of removed records.
   */
  private reclaimHistory(): number {
    if (this.info.view.pinned || !this.store.state.online) return 0;
    const removed = this.info.record.trimHistory(this.historyLimits);
    if (removed) releaseHistoryLayout(this.info.record);
    return removed;
  }

  /** Release the selected transcript and its layout caches. */
  private releaseTranscript(): void {
    this.promptBackfill?.abort(); this.promptBackfill = undefined;
    this.info.reset();
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
