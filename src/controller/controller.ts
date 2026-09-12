/** Application facade: composes the connection, session, catalog and cost domains. */
import { Client } from '../transport/client.ts';
import { writeHeapSnapshot } from '../storage/index.ts';
import { errorText, type Json, type ObjectValue } from '../transport/wire.ts';
import { DEFAULT_HISTORY_LIMITS, type HistoryLimits } from '../session/memory.ts';
import { layoutStats } from '../session/history.ts';
import { markdownCacheStats } from '../session/markdown.ts';
import { SessionController } from '../session/controller.ts';
import { CatalogController } from '../catalog/controller.ts';
import type { Telemetry } from '../session/telemetry.ts';
import type { Transcript } from '../session/transcript.ts';
import type { CostLedger } from '../cost/ledger.ts';
import { CostController } from '../cost/controller.ts';
import { ConnectionController, type ConnectionListener, type ConnectionOptions } from './connection.ts';
import { MemoryLog } from './memory-log.ts';
import { clearReactMeasures, measureCount } from './perf-measures.ts';
import { initialState, type ControllerStore, type State } from '../state.ts';
import type { HistorySearch, RemovalTarget } from '../session/types.ts';

/** Application facade over the domain controllers; the UI owns only this object.
 *
 * State lives here, connection generations live in `connection`, the selected session and its
 * history live in `session`, model metadata lives in `catalog`, and billing lives in `cost`.
 */
export class Controller implements ControllerStore, ConnectionListener {
  state: State = initialState();
  /** Physical connection, retry loop and projection store. */
  readonly connection: ConnectionController;
  /** Selected session, follow stream, history and interactions. */
  readonly session: SessionController;
  /** Model routes and agent-preset metadata. */
  readonly catalog: CatalogController;
  /** Background billing scan; present only when a ledger was supplied. */
  readonly cost: CostController | undefined;
  /** Bounded runtime memory samples; present only when a log path was supplied. */
  readonly memoryLog: MemoryLog | undefined;
  private readonly observers = new Set<() => void>();
  private selector = 0;

  constructor(readonly base: string, token: string | undefined, private readonly initialSession?: string,
    makeClient: () => Client = () => new Client(base),
    authenticate: (client: Client) => Promise<void> = client => client.authenticate(token ?? ''), readonly costs?: CostLedger, readonly historyLimits: HistoryLimits = DEFAULT_HISTORY_LIMITS, readonly memoryLogPath?: string,
    /** Directory this client runs in, offered as a workspace when the host has not registered it. */
    readonly localDirectory: string = process.cwd()) {
    const options: ConnectionOptions = { base, token, initialSession, makeClient, authenticate };
    this.connection = new ConnectionController(this, options, this);
    this.session = new SessionController(this, this.connection, this.connection, historyLimits);
    this.catalog = new CatalogController(this, this.connection);
    if (costs) this.cost = new CostController(costs, {
      client: () => this.connection.client(),
      online: () => this.state.online,
      signal: () => this.connection.signal(),
      publish: () => this.update({}),
    });
    if (memoryLogPath !== undefined) this.memoryLog = new MemoryLog(memoryLogPath, () => this.memorySample());
  }

  /** React-compatible state subscription. */
  subscribe = (listener: () => void): (() => void) => {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  };

  /** Snapshot identity changes only when the controller publishes. */
  snapshot = (): State => this.state;

  /** Current projection store; replaced at each connection generation. */
  get telemetry(): Telemetry { return this.connection.telemetry; }

  /** @returns The current selector generation. */
  selection(): number { return this.selector; }

  /** Advance the selector generation when the selected workspace or session changes. */
  bumpSelection(): void { this.selector++; }

  /** Publish a state patch, re-deriving the visible pending interactions.
   * @param patch - Fields to replace on the current state.
   */
  update(patch: Partial<State>): void {
    const next = { ...this.state, ...patch, version: this.state.version + 1 };
    next.pending = next.online && next.screen === 'chat' && this.session
      ? this.session.pendingFor(next) : [];
    this.state = next;
    for (const observer of this.observers) observer();
  }

  /** Start one retry loop, with a fresh snapshot generation after every disconnect. */
  start(): void { this.connection.start(); this.memoryLog?.start(); }

  /** Cancel retries and HTTP, close the socket, and release session and catalog work. */
  async stop(): Promise<void> {
    await this.connection.stop();
    await this.session.settle();
    await this.catalog.settle();
    await this.cost?.stop();
    await this.memoryLog?.stop();
    this.session.release();
  }

  /** Stop the selected turn and then close, so quitting does not leave host work running.
   * An idle session stays untouched, and an in-flight cancellation is awaited rather than repeated.
   */
  async shutdown(): Promise<void> {
    if (this.session.active) await this.session.interrupt(true);
    await this.stop();
  }

  /** Run a UI operation and expose errors without destroying the current input.
   * @param operation - Operation to run while the client is busy.
   * @returns Whether the operation completed.
   */
  async perform(operation: () => Promise<void>): Promise<boolean> {
    if (this.state.busy || !this.state.online) return false;
    this.update({ busy: true, error: '' });
    try { await operation(); return true; }
    catch (error) { this.update({ error: errorText(error) }); return false; }
    finally { this.update({ busy: false }); }
  }

  /** Read the counters one memory sample records; content never leaves as text.
   *
   * The retained transcript and the ledger are small in practice, so a sample also reads the two
   * structures that grow with rendered content — the layout row cache and the bounded math and
   * diagram cache — and the work the last cost scan re-read, which is the only timer here whose
   * per-pass work scales with history. With a runtime that exposes `gc`, the sample also reports
   * the heap after a forced collection, so retained state and uncollected garbage stay distinct.
   *
   * React's development build appends one performance-timeline entry per rendered component and Node
   * never trims them, so the sample counts them and then bounds them; `perfMeasuresCleared` separates
   * entries this sample released from entries the build created since the last one.
   */
  private memorySample(): ObjectValue {
    const memory = process.memoryUsage();
    const transcript = this.state.transcript;
    const ledger = this.costs?.summary();
    const layout = layoutStats(transcript);
    const markdown = markdownCacheStats();
    const measuresCleared = clearReactMeasures();
    const measures = measureCount();
    const gc = this.forcedGc();
    return {
      time: new Date().toISOString(),
      rss: memory.rss, heapTotal: memory.heapTotal, heapUsed: memory.heapUsed,
      external: memory.external, arrayBuffers: memory.arrayBuffers,
      ...(measures === undefined ? {} : { perfMeasures: measures, perfMeasuresCleared: measuresCleared }),
      ...(gc === undefined ? {} : { heapUsedAfterGc: gc.used, gcMs: gc.ms }),
      online: this.state.online, screen: this.state.screen,
      session: this.state.sessionId ?? null,
      pinned: this.session.pinned,
      records: transcript.retainedRecordCount, retainedBytes: transcript.retainedBytes,
      beforeSeq: transcript.beforeSeq ?? null, hasMore: transcript.hasMore,
      live: transcript.hasLiveContent, liveChars: transcript.liveText.length, pending: this.state.pending.length,
      thoughts: transcript.thoughts.length,
      ...(layout === undefined ? {} : { layoutRows: layout.rows, layoutCacheBytes: layout.cacheBytes, layoutSpans: layout.spans,
        layoutSpanChars: layout.spanChars, layoutLiveWraps: layout.liveWraps, layoutLiveMarkdown: layout.liveMarkdown }),
      markdownEntries: markdown.entries, markdownChars: markdown.chars, markdownHits: markdown.hits, markdownMisses: markdown.misses,
      scanning: this.costs?.scanning ?? false,
      ...(this.costs?.lastScan === undefined ? {} : { scanSessions: this.costs.lastScan.sessions,
        scanPages: this.costs.lastScan.pages, scanEvents: this.costs.lastScan.events }),
      ...(ledger === undefined ? {} : { ledgerSessions: ledger.sessions, ledgerRecords: ledger.records, ledgerUnpriced: ledger.unpriced }),
    };
  }

  /** Collect before reading the heap when the runtime exposes a collection.
   * @returns Heap in use after the collection and how long it took, or undefined without `global.gc`.
   */
  private forcedGc(): { used: number; ms: number } | undefined {
    const collect = (globalThis as { gc?: () => void }).gc;
    if (typeof collect !== 'function') return undefined;
    const start = Date.now();
    collect();
    return { used: process.memoryUsage().heapUsed, ms: Date.now() - start };
  }

  /** A new generation starts; drop generation-scoped domain state. */
  begin(): void {
    this.session.beginGeneration();
    this.catalog.reset();
    this.update({ controlError: undefined });
  }

  /** The event stream is ready and the control baseline is applied. */
  async ready(): Promise<void> {
    this.catalog.refresh();
    this.update({ online: true, status: 'Connected', error: '', pending: [] });
    const screen = this.state.screen;
    await this.session.showPicker(screen === 'sessions' ? 'sessions' : 'workspaces');
    const sessionId = this.state.sessionId ?? this.initialSession;
    if (sessionId && (screen === 'chat' || this.initialSession && !this.state.sessionId)) await this.session.selectSession(sessionId);
    this.cost?.start();
  }

  /** The generation ended; invalidate session work and stop the scan. */
  async ended(): Promise<void> {
    this.session.endGeneration();
    await this.cost?.stop();
  }

  /** Deliver a host waterfall to the session domain.
   * @param frame - One decoded waterfall frame.
   * @returns Whether the session domain retained it.
   */
  waterfall(frame: ObjectValue): boolean { return this.session.waterfall(frame); }

  /** Drop a waterfall the host cancelled.
   * @param eventId - Correlation id previously retained.
   */
  cancelled(eventId: string): void { this.session.cancelled(eventId); }

  /** Apply one host running-state notification.
   * @param sessionId - Session whose state changed.
   * @param running - Whether the host still runs that session.
   */
  status(sessionId: string, running: boolean): void { this.session.status(sessionId, running); }

  /** Surface a host-reported session error.
   * @param sessionId - Session the host reported on.
   * @param error - Error payload as delivered by the host.
   */
  error(sessionId: unknown, error: unknown): void { this.session.reportError(sessionId, error); }

  /** Reload the model catalog after a host settings, credential or adapter change. */
  invalidated(): void { this.catalog.refresh(); }

  /** Refresh billing after a turn finished. */
  idle(): void { this.cost?.onTurnIdle(); }

  /** @returns Host running state of the selected session. */
  get running(): boolean { return this.session.running; }

  /** @returns Current session title, falling back to the list title and then the ID. */
  get sessionName(): string | undefined { return this.session.sessionName; }

  /** @returns Current agent-preset label. */
  get sessionMode(): string | undefined { return this.session.sessionMode; }

  /** @returns Epoch start of the active turn, when known. */
  get workingSince(): number | undefined { return this.session.workingSince; }

  /** @returns Sessions accounted to the selected workspace, minus archived identities. */
  get visibleSessions(): ObjectValue[] { return this.session.visibleSessions; }

  /** @returns Unanswered interactions by session, for the state each list row reports. */
  pendingCounts(): ReadonlyMap<string, number> { return this.session.pendingCounts(); }

  /** Load the optional preset roster once per connection. */
  loadPresetNames(): void { this.catalog.loadPresetNames(); }

  /** @returns Host model routes and adapter-owned reasoning choices. */
  async modelCatalog(): Promise<ObjectValue> { return this.catalog.modelCatalog(); }

  /** Select the next request's model.
   * @param provider - Host provider route ID.
   * @param model - Exact model ID.
   * @param reasoningEffort - Optional adapter-owned effort ID.
   */
  async selectModel(provider: string, model: string, reasoningEffort?: string): Promise<void> {
    await this.catalog.selectModel(provider, model, reasoningEffort);
  }

  /** Stop the selected turn, or allow exit only while idle.
   * @param force - Send an explicit cancellation even when the cached running flag is idle.
   * @returns True when the caller may exit.
   */
  interrupt(force = false): Promise<boolean> { return this.session.interrupt(force); }

  /** Keep history stable while the user reads, searches, or expands it.
   * @param pinned - Whether the main transcript is being read away from its tail.
   */
  pinHistory(pinned: boolean): void { this.session.pinHistory(pinned); }

  /** Refresh all HTTP-visible sessions without changing the selected conversation.
   * @param signal - Optional cancellation for an explicit /cost refresh.
   */
  async refreshCosts(signal: AbortSignal = this.connection.signal()): Promise<void> { await this.cost?.refresh(signal); }

  /** Refresh both lists from the host, then show the requested picker.
   * @param screen - Picker to display after the refresh.
   */
  async showPicker(screen: 'workspaces' | 'sessions'): Promise<void> { await this.session.showPicker(screen); }

  /** Resolve a removal command to one reviewable object.
   * @param kind - Workspace registration removal or session archival.
   * @param query - Exact name, ID, or unambiguous ID prefix.
   * @returns The fixed identity and display details for confirmation.
   */
  async removalTarget(kind: 'workspace' | 'session', query: string): Promise<RemovalTarget> { return this.session.removalTarget(kind, query); }

  /** Apply a confirmed removal or verified empty-session archival.
   * @param target - Exact workspace or session identity reviewed by the user.
   */
  async removeTarget(target: RemovalTarget): Promise<void> { await this.session.removeTarget(target); }

  /** Pick a workspace, or use all sessions when the identity is omitted.
   * @param workspaceId - Workspace to select, if any.
   */
  pickWorkspace(workspaceId?: string): void { this.session.pickWorkspace(workspaceId); }

  /** Open a workspace picker, or resolve a workspace target.
   * @param query - Workspace target, if any.
   */
  async switchWorkspace(query?: string): Promise<void> { await this.session.switchWorkspace(query); }

  /** Guide session selection, list all sessions with `all`, or resolve a target.
   * @param query - Session target, `all`, or nothing for the guided picker.
   */
  async switchSession(query?: string): Promise<void> { await this.session.switchSession(query); }

  /** Prompt for a host path without starting a local agent. */
  enterPath(): void { this.session.enterPath(); }

  /** Register a host directory and move to its session picker.
   * @param path - Absolute directory path on the host.
   */
  async createWorkspace(path: string): Promise<void> { await this.session.createWorkspace(path); }

  /** Create a session in the selected workspace. */
  async createSession(): Promise<void> { await this.session.createSession(); }

  /** Replace the selected transcript and follow the session.
   * @param sessionId - Session to follow.
   */
  async selectSession(sessionId: string): Promise<void> { await this.session.selectSession(sessionId); }

  /** Wait for the selected follow snapshot.
   * @param signal - Cancels waiting without closing the session.
   */
  async waitForHistory(signal: AbortSignal): Promise<void> { await this.session.waitForHistory(signal); }

  /** Search host session results.
   * @param query - Literal message text.
   * @param workspaceOnly - Restrict hits to the selected workspace.
   * @param signal - Cancels the HTTP search.
   * @returns Session snippets and the global truncation flag.
   */
  async searchSessions(query: string, workspaceOnly: boolean, signal: AbortSignal): Promise<{ items: ObjectValue[]; hasMore: boolean }> {
    return this.session.searchSessions(query, workspaceOnly, signal);
  }

  /** Search host paths for the composer's `@` completion.
   * @param query - Path text after @.
   * @param signal - Cancels an obsolete lookup.
   * @returns Validated candidates in host order.
   */
  async references(query: string, signal: AbortSignal) { return this.session.references(query, signal); }

  /** Execute a human command directly, outside the model prompt queue.
   * @param line - Complete slash command, including arguments.
   * @param signal - Cancels the request while the host performs compaction.
   * @returns The host's successful command result text.
   */
  async command(line: string, signal: AbortSignal): Promise<string> { return this.session.command(line, signal); }

  /** Remove one host-owned pending input.
   * @param itemId - Queue occurrence identity from session/control.
   */
  async removeQueued(itemId: string): Promise<void> { await this.session.removeQueued(itemId); }

  /** Export the selected host log to a new local ZIP file.
   * @param path - Optional local destination; existing files are never overwritten.
   * @param signal - Cancels the download and removes an incomplete file.
   * @returns Absolute saved filename.
   */
  async exportLog(path: string | undefined, signal: AbortSignal): Promise<string> { return this.session.exportLog(path, signal); }

  /** Save loaded Markdown, diagrams and math as offline HTML.
   * @param path - Optional filename; existing files are not replaced.
   * @param signal - Cancels the write.
   * @returns Absolute saved filename.
   */
  async exportHtml(path: string | undefined, signal: AbortSignal): Promise<string> { return this.session.exportHtml(path, signal); }

  /** Write a V8 heap snapshot into this client's working directory; the write pauses the client.
   * @param tag - Sampling-point label naming the file, such as `after-stress`.
   * @returns Absolute path of the written snapshot.
   */
  heapSnapshot(tag?: string): string { return writeHeapSnapshot(process.cwd(), tag); }

  /** Admit text once as steering while running, or a new turn while idle.
   * @param text - Composed prompt text.
   */
  async prompt(text: string): Promise<void> { await this.session.prompt(text); }

  /** Cancel the active turn; pending queue items remain host-owned. */
  async cancelTurn(): Promise<void> { await this.session.cancelTurn(); }

  /** Add a page before the retained window.
   * @param signal - Cancels local paging without interrupting the remote agent.
   * @param transcript - Transcript to extend; defaults to the live one.
   */
  async older(signal?: AbortSignal, transcript?: Transcript): Promise<void> { await this.session.older(signal, transcript); }

  /** Search the loaded history page by page.
   * @param query - Literal, case-insensitive text including folded reasoning.
   * @param signal - Cancels HTTP and processing without cancelling the agent.
   * @returns Newest-first bounded summaries and an explicit truncation flag.
   */
  async searchHistory(query: string, signal: AbortSignal): Promise<HistorySearch> { return this.session.searchHistory(query, signal); }

  /** Load a separate small window ending at a search target.
   * @param target - Durable message sequence to display.
   * @param signal - Cancels the target-page request.
   * @returns A caller-owned historical window that must be disposed when closed.
   */
  async historyAt(target: number, signal: AbortSignal): Promise<Transcript> { return this.session.historyAt(target, signal); }

  /** Load the prefix required for an explicit history jump.
   * @param target - Visible record sequence, or first for the oldest available history.
   * @param signal - Cancels local paging without interrupting the remote agent.
   */
  async historyThrough(target: number | 'first', signal: AbortSignal): Promise<void> { await this.session.historyThrough(target, signal); }

  /** Answer the oldest selected-session interaction, after explicit user action.
   * @param value - Structured answer value or approval outcome.
   */
  async answer(value: Json): Promise<void> { await this.session.answer(value); }

  /** Approve or reject the pending approval request.
   * @param allowed - Whether the request is approved once.
   */
  async approve(allowed: boolean): Promise<void> { await this.session.approve(allowed); }
}

export type { HistorySearch, RemovalTarget } from '../session/types.ts';
export type { State } from '../state.ts';
