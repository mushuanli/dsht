/** Application facade: composes the connection, session, catalog and cost domains. */
import { Client } from '../transport/client.ts';
import { writeHeapSnapshot } from '../storage/index.ts';
import { errorText, type Json, type ObjectValue } from '../transport/wire.ts';
import type { HostEvent } from '../transport/events.ts';
import { DEFAULT_HISTORY_LIMITS, type HistoryLimits } from '../session/memory.ts';
import { layoutStats, type SessionRender } from '../session/history.ts';
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
import { ShellController } from '../shell/index.ts';
import type { HistorySearch, AnswerValue, RemovalTarget } from '../session/types.ts';
import type { FileReference } from '../session/references.ts';
import type { InteractionState, ModelState, OptionState, PanelState } from '../session/info.ts';
import type { Reasoning } from '../session/history.ts';

/** Environment for a local `!` command: this client's variables without its credentials.
 *
 * `DSH_URL` is removed as well as the token, because the URL form the README documents can carry a
 * token in its query string. Commands therefore run with the operator's environment, not this
 * client's session.
 * @returns A copy of the environment safe to hand to a child process.
 */
function shellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DSH_TOKEN; delete env.DSH_URL;
  return env;
}

/** Mutating operations the UI drives; each owns its busy/error envelope. */
export interface Actions {
  switchWorkspace(workspaceId?: string): Promise<boolean>;
  switchSession(query?: string): Promise<boolean>;
  selectSession(sessionId: string): Promise<boolean>;
  createWorkspace(path: string): Promise<boolean>;
  createSession(): Promise<boolean>;
  showPicker(screen: 'workspaces' | 'sessions'): Promise<boolean>;
  removeTarget(target: RemovalTarget): Promise<boolean>;
  removalTarget(kind: 'workspace' | 'session', query: string): Promise<RemovalTarget | undefined>;
  waitForHistory(signal: AbortSignal): Promise<boolean>;
  searchSessions(query: string, workspaceOnly: boolean, signal: AbortSignal): Promise<{ items: ObjectValue[]; hasMore: boolean } | undefined>;
  searchHistory(query: string, signal: AbortSignal): Promise<HistorySearch | undefined>;
  prompt(text: string): Promise<boolean>;
  cancelTurn(): Promise<boolean>;
  answer(value: AnswerValue): Promise<boolean>;
  approve(allowed: boolean): Promise<boolean>;
  dismissQuestion(): Promise<boolean>;
  /** Repeated keys share one cancellation; it reports exit eligibility itself. */
  interrupt(force?: boolean): Promise<boolean>;
  older(signal?: AbortSignal, transcript?: Transcript): Promise<boolean>;
  historyThrough(target: number | 'first', signal: AbortSignal): Promise<boolean>;
  removeQueued(itemId: string): Promise<boolean>;
  command(line: string, signal: AbortSignal): Promise<string | undefined>;
  exportLog(path: string | undefined, signal: AbortSignal): Promise<string | undefined>;
  exportHtml(path: string | undefined, signal: AbortSignal): Promise<string | undefined>;
  selectModel(provider: string, model: string, reasoningEffort?: string): Promise<boolean>;
  modelCatalog(): Promise<ObjectValue | undefined>;
  refreshCosts(signal?: AbortSignal): Promise<boolean>;
  /** Local, immediate setters: no request, so they keep the synchronous contract. */
  loadPresetNames(): void;
  enterPath(): void;
  pickWorkspace(workspaceId?: string): void;
  setViewWindow(window?: Transcript): void;
  pinHistory(pinned: boolean): void;
  setAnswers(answers: Record<string, AnswerValue['answers']>): void;
  setOption(option?: OptionState): void;
  setApproval(approval?: InteractionState['approval']): void;
  recordRecall(value: string): void;
  resetRecall(): void;
  refillRecall(): boolean;
  heapSnapshot(tag?: string): string;
}

/** Read-only operations the UI drives; none of them changes observable state. */
export interface Queries {
  readonly running: boolean;
  readonly sessionName: string | undefined;
  readonly sessionMode: string | undefined;
  readonly workingSince: number | undefined;
  readonly visibleSessions: ObjectValue[];
  readonly record: Transcript;
  readonly window: Transcript | undefined;
  readonly interaction: InteractionState;
  readonly telemetry: Telemetry;
  readonly recallAtOldest: boolean;
  readonly recallLength: number;
  readonly recallHasOlder: boolean;
  pendingCounts(): ReadonlyMap<string, number>;
  recall(direction: -1 | 1, current: string): string;
  references(query: string, signal: AbortSignal): Promise<FileReference[]>;
  historyAt(target: number, signal: AbortSignal): Promise<Transcript>;
  /** Plain rows and offsets for one laid-out record. */
  render(input: { transcript: Transcript; width: number; folds: ReadonlySet<number>; liveReasoning: Reasoning }): SessionRender;
}

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
  /** Local `!` commands, run on this machine and shown inline in the transcript. */
  readonly shell: ShellController;
  /** Mutating surface the UI drives. */
  readonly actions: Actions;
  /** Read-only surface the UI drives. */
  readonly queries: Queries;
  private readonly observers = new Set<() => void>();
  private selector = 0;

  constructor(readonly base: string, token: string | undefined, private readonly initialSession?: string,
    makeClient: () => Client = () => new Client(base),
    authenticate: (client: Client) => Promise<void> = client => client.authenticate(token ?? ''), readonly costs?: CostLedger, readonly historyLimits: HistoryLimits = DEFAULT_HISTORY_LIMITS, readonly memoryLogPath?: string,
    /** Directory this client runs in, offered as a workspace when the host has not registered it. */
    readonly localDirectory: string = process.cwd(),
    /** Whether `!` may run local commands; the CLI disables it with `--no-shell`. */
    shellEnabled = true) {
    const options: ConnectionOptions = { base, token, initialSession, makeClient, authenticate };
    this.connection = new ConnectionController(this, options, this);
    this.session = new SessionController(this, this.connection, this.connection, historyLimits);
    this.shell = new ShellController({
      publish: () => this.update({}),
      cwd: () => this.localDirectory,
      env: () => shellEnv(),
      anchor: () => this.state.session.record.readThrough,
    }, shellEnabled);
    this.catalog = new CatalogController(this, this.connection);
    if (costs) this.cost = new CostController(costs, {
      client: () => this.connection.client(),
      online: () => this.state.online,
      signal: () => this.connection.signal(),
      publish: () => this.update({}),
      // The scan already reads every session's whole history; handing its pages to the session
      // domain lets the prompt cache pick them up, so one open does not pay for a second walk.
      scanPage: (sessionId, records) => this.session.rememberScanPage(sessionId, records),
      scanDone: sessionId => this.session.rememberScanDone(sessionId),
    });
    if (memoryLogPath !== undefined) this.memoryLog = new MemoryLog(memoryLogPath, () => this.memorySample());
    this.actions = this.buildActions();
    this.queries = this.buildQueries();
  }

  /** React-compatible state subscription. */
  subscribe = (listener: () => void): (() => void) => {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  };

  /** Snapshot identity changes only when the controller publishes. */
  snapshot = (): State => this.state;

  /** Current projection store; replaced at each connection generation. */
  private get telemetry(): Telemetry { return this.session.telemetry; }

  /** Record of the selected session; the one strong owner lives in `State.session`. */
  private get record(): Transcript { return this.state.session.record; }

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
    // The shell service owns its blocks; state carries only the plain snapshot the UI renders.
    if (this.shell) next.shell = this.shell.snapshot();
    this.state = next;
    for (const observer of this.observers) observer();
  }

  /** Bind every mutating entry point to its private implementation. */
  private buildActions(): Actions {
    return {
      switchWorkspace: id => this.runAction(() => this.switchWorkspace(id)),
      switchSession: query => this.runAction(() => this.switchSession(query)),
      selectSession: id => this.runAction(() => this.selectSession(id)),
      createWorkspace: path => this.runAction(() => this.createWorkspace(path)),
      createSession: () => this.runAction(() => this.createSession()),
      showPicker: screen => this.runAction(() => this.showPicker(screen)),
      removeTarget: target => this.runAction(() => this.removeTarget(target)),
      removalTarget: (kind, query) => this.runActionValue(() => this.removalTarget(kind, query)),
      waitForHistory: signal => this.runAction(() => this.waitForHistory(signal)),
      searchSessions: (query, workspaceOnly, signal) => this.runActionValue(() => this.searchSessions(query, workspaceOnly, signal)),
      searchHistory: (query, signal) => this.runActionValue(() => this.searchHistory(query, signal)),
      prompt: text => this.runAction(() => this.prompt(text)),
      cancelTurn: () => this.runAction(() => this.cancelTurn()),
      answer: value => this.runAction(() => this.answer(value)),
      approve: allowed => this.runAction(() => this.approve(allowed)),
      dismissQuestion: () => this.runAction(() => this.dismissQuestion()),
      interrupt: force => this.interrupt(force),
      older: (signal, transcript) => this.runAction(() => this.older(signal, transcript)),
      historyThrough: (target, signal) => this.runAction(() => this.historyThrough(target, signal)),
      removeQueued: itemId => this.runAction(() => this.removeQueued(itemId)),
      command: (line, signal) => this.runActionValue(() => this.command(line, signal)),
      exportLog: (path, signal) => this.runActionValue(() => this.exportLog(path, signal)),
      exportHtml: (path, signal) => this.runActionValue(() => this.exportHtml(path, signal)),
      selectModel: (provider, model, effort) => this.runAction(() => this.selectModel(provider, model, effort)),
      modelCatalog: () => this.runActionValue(() => this.modelCatalog()),
      refreshCosts: signal => this.runAction(() => this.refreshCosts(signal)),
      loadPresetNames: () => this.loadPresetNames(),
      enterPath: () => this.enterPath(),
      pickWorkspace: id => this.pickWorkspace(id),
      setViewWindow: window => this.setViewWindow(window),
      pinHistory: pinned => this.pinHistory(pinned),
      setAnswers: answers => this.setAnswers(answers),
      setOption: option => this.setOption(option),
      setApproval: approval => this.setApproval(approval),
      recordRecall: value => this.recordRecall(value),
      resetRecall: () => this.resetRecall(),
      refillRecall: () => this.refillRecall(),
      heapSnapshot: tag => this.heapSnapshot(tag),
    };
  }

  /** Bind every read-only entry point; getters stay live because the values move between renders. */
  private buildQueries(): Queries {
    const controller = this;
    return {
      get running() { return controller.running; },
      get sessionName() { return controller.sessionName; },
      get sessionMode() { return controller.sessionMode; },
      get workingSince() { return controller.workingSince; },
      get visibleSessions() { return controller.visibleSessions; },
      get record() { return controller.record; },
      get window() { return controller.window; },
      get interaction() { return controller.interaction; },
      get telemetry() { return controller.telemetry; },
      get recallAtOldest() { return controller.recallAtOldest; },
      get recallLength() { return controller.recallLength; },
      get recallHasOlder() { return controller.recallHasOlder; },
      pendingCounts: () => controller.pendingCounts(),
      recall: (direction, current) => controller.recall(direction, current),
      references: (query, signal) => controller.references(query, signal),
      historyAt: (target, signal) => controller.historyAt(target, signal),
      render: input => controller.render(input),
    };
  }

  /** Start one retry loop, with a fresh snapshot generation after every disconnect. */
  start(): void { this.connection.start(); this.memoryLog?.start(); }

  /** Cancel retries and HTTP, close the socket, and release session and catalog work. */
  async stop(): Promise<void> {
    await this.shell.stop();
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

  /** Run one mutating operation inside the busy/error envelope the UI reports.
   *
   * Private on purpose: the application owns the envelope, so a caller never hands the controller a
   * closure to orchestrate. Every entry of `actions` uses it.
   * @param operation - Operation to run while the client is busy.
   * @returns Whether the operation ran to completion.
   */
  private async runAction(operation: () => Promise<void>): Promise<boolean> {
    if (this.state.operation.busy || !this.state.online) return false;
    this.update({ operation: { busy: true, error: '' } });
    try { await operation(); return true; }
    catch (error) { this.update({ operation: { ...this.state.operation, error: errorText(error) } }); return false; }
    finally { this.update({ operation: { ...this.state.operation, busy: false } }); }
  }

  /** Same envelope, for an operation that produces a value the caller needs. */
  private async runActionValue<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.state.operation.busy || !this.state.online) return undefined;
    this.update({ operation: { busy: true, error: '' } });
    try { return await operation(); }
    catch (error) { this.update({ operation: { ...this.state.operation, error: errorText(error) } }); return undefined; }
    finally { this.update({ operation: { ...this.state.operation, busy: false } }); }
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
    const transcript = this.state.session.record;
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
    this.update({ online: true, status: 'Connected', pending: [], operation: { ...this.state.operation, error: '' } });
    const screen = this.state.screen;
    await this.session.showPicker(screen === 'sessions' ? 'sessions' : 'workspaces');
    // Starting inside a registered workspace's directory already answers the first question, so the
    // reader lands on that workspace's sessions instead of a list they would pick from by hand.
    if (screen !== 'sessions' && !this.initialSession && this.session.adoptLocalWorkspace(this.localDirectory) !== undefined) {
      this.update({ status: 'Workspace from this directory · ← to switch' });
    }
    const sessionId = this.state.sessionId ?? this.initialSession;
    if (sessionId && (screen === 'chat' || this.initialSession && !this.state.sessionId)) await this.session.selectSession(sessionId);
    this.cost?.start();
  }

  /** The generation ended; invalidate session work and stop the scan. */
  async ended(): Promise<void> {
    this.session.endGeneration();
    await this.cost?.stop();
  }

  /** Route one normalized host event to the domain that owns it.
   *
   * This is the composition point: the connection knows only that an event arrived, so a feature
   * never has to hold another feature. `false` means the host's waterfall is still unsettled.
   * @param event - Normalized host event.
   * @returns Whether a retained waterfall was consumed.
   */
  event(event: HostEvent): boolean {
    switch (event.kind) {
      case 'approval-request':
      case 'question-request': return this.session.accept(event);
      case 'waterfall-delegate': return false;
      case 'cancel': this.session.cancelled(event.eventId); return true;
      case 'agent-status':
        this.session.status(event.sessionId, event.running);
        if (!event.running) this.cost?.onTurnIdle();
        return true;
      case 'catalog-invalidated': this.catalog.refresh(); return true;
      case 'session-error': this.session.reportError(event.sessionId, event.error); return true;
      case 'control': this.session.acceptControl(event.frame); return true;
    }
  }

  /** @returns Host running state of the selected session. */
  private get running(): boolean { return this.session.running; }

  /** @returns Current session title, falling back to the list title and then the ID. */
  private get sessionName(): string | undefined { return this.session.sessionName; }

  /** @returns Current agent-preset label. */
  private get sessionMode(): string | undefined { return this.session.sessionMode; }

  /** @returns Epoch start of the active turn, when known. */
  private get workingSince(): number | undefined { return this.session.workingSince; }

  /** @returns Sessions accounted to the selected workspace, minus archived identities. */
  private get visibleSessions(): ObjectValue[] { return this.session.visibleSessions; }

  /** @returns Unanswered interactions by session, for the state each list row reports. */
  private pendingCounts(): ReadonlyMap<string, number> { return this.session.pendingCounts(); }

  /** Load the optional preset roster once per connection. */
  private loadPresetNames(): void { this.catalog.loadPresetNames(); }

  /** @returns Host model routes and adapter-owned reasoning choices. */
  private async modelCatalog(): Promise<ObjectValue> { return this.catalog.modelCatalog(); }

  /** Select the next request's model.
   * @param provider - Host provider route ID.
   * @param model - Exact model ID.
   * @param reasoningEffort - Optional adapter-owned effort ID.
   */
  private async selectModel(provider: string, model: string, reasoningEffort?: string): Promise<void> {
    await this.catalog.selectModel(provider, model, reasoningEffort);
  }

  /** Stop the selected turn, or allow exit only while idle.
   * @param force - Send an explicit cancellation even when the cached running flag is idle.
   * @returns True when the caller may exit.
   */
  private interrupt(force = false): Promise<boolean> { return this.session.interrupt(force); }

  /** One-line estimate of the selected session's cost, or `?` while the ledger has no entry for it. */
  /** Keep history stable while the user reads, searches, or expands it.
   * @param pinned - Whether the main transcript is being read away from its tail.
   */
  private pinHistory(pinned: boolean): void { this.session.pinHistory(pinned); }

  /** @returns The detached history window the reader opened, if any. */
  private get window(): Transcript | undefined { return this.session.window; }

  /** Show a detached history window, releasing the one it replaces.
   * @param window - Record to display, or undefined to return to the live transcript.
   */
  private setViewWindow(window?: Transcript): void { this.session.setViewWindow(window); }

  /** Recall one step through the selected session's prompt index; never touches the network.
   * @param direction - Negative for older input, positive for newer input.
   * @param current - Composer content before recall began, restored at the newest position.
   * @returns The recalled prompt, or the unsent draft.
   */
  private recall(direction: -1 | 1, current: string): string { return this.session.recall(direction, current); }

  /** Remember a locally submitted command, which never becomes a durable session record.
   * @param value - Submitted command text.
   */
  private recordRecall(value: string): void { this.session.recordRecall(value); }

  /** Leave recall navigation because the composer was edited or replaced. */
  private resetRecall(): void { this.session.resetRecall(); }

  /** Whether recall is parked on the oldest prompt the session retains. */
  private get recallAtOldest(): boolean { return this.session.recallAtOldest; }

  /** How many prompts the selected session retains for recall. */
  private get recallLength(): number { return this.session.recallLength; }

  /** Whether an older prompt is reachable, in the loaded window or on the host. */
  private get recallHasOlder(): boolean { return this.session.recallHasOlder; }

  /** Recover older prompts from the loaded window before spending a page request.
   * @returns Whether any older prompt was recovered.
   */
  private refillRecall(): boolean { return this.session.refillRecall(); }

  /** Local answer state for the selected session's pending waterfalls. */
  private get interaction(): InteractionState { return this.session.interaction; }

  /** Replace the partly collected answers, keyed by waterfall event id.
   * @param answers - Answers collected so far, by event id.
   */
  private setAnswers(answers: Record<string, AnswerValue['answers']>): void { this.session.setAnswers(answers); }

  /** Replace the pending question's option keyboard state.
   * @param option - Highlighted option, toggled labels and free-text mode; undefined clears it.
   */
  private setOption(option?: OptionState): void { this.session.setOption(option); }

  /** Replace the pending approval's selected row.
   * @param approval - Selected approval row; undefined clears the highlight.
   */
  private setApproval(approval?: InteractionState['approval']): void { this.session.setApproval(approval); }

  /** Refresh all HTTP-visible sessions without changing the selected conversation.
   * @param signal - Optional cancellation for an explicit /cost refresh.
   */
  private async refreshCosts(signal: AbortSignal = this.connection.signal()): Promise<void> { await this.cost?.refresh(signal); }

  /** Refresh both lists from the host, then show the requested picker.
   * @param screen - Picker to display after the refresh.
   */
  private async showPicker(screen: 'workspaces' | 'sessions'): Promise<void> { await this.session.showPicker(screen); }

  /** Resolve a removal command to one reviewable object.
   * @param kind - Workspace registration removal or session archival.
   * @param query - Exact name, ID, or unambiguous ID prefix.
   * @returns The fixed identity and display details for confirmation.
   */
  private async removalTarget(kind: 'workspace' | 'session', query: string): Promise<RemovalTarget> { return this.session.removalTarget(kind, query); }

  /** Apply a confirmed removal or verified empty-session archival.
   * @param target - Exact workspace or session identity reviewed by the user.
   */
  private async removeTarget(target: RemovalTarget): Promise<void> { await this.session.removeTarget(target); }

  /** Pick a workspace, or use all sessions when the identity is omitted.
   * @param workspaceId - Workspace to select, if any.
   */
  private pickWorkspace(workspaceId?: string): void { this.session.pickWorkspace(workspaceId); }

  /** Open a workspace picker, or resolve a workspace target.
   * @param query - Workspace target, if any.
   */
  private async switchWorkspace(query?: string): Promise<void> { await this.session.switchWorkspace(query); }

  /** Guide session selection, list all sessions with `all`, or resolve a target.
   * @param query - Session target, `all`, or nothing for the guided picker.
   */
  private async switchSession(query?: string): Promise<void> { await this.session.switchSession(query); }

  /** Prompt for a host path without starting a local agent. */
  private enterPath(): void { this.session.enterPath(); }

  /** Register a host directory and move to its session picker.
   * @param path - Absolute directory path on the host.
   */
  private async createWorkspace(path: string): Promise<void> { await this.session.createWorkspace(path); }

  /** Create a session in the selected workspace. */
  private async createSession(): Promise<void> { await this.session.createSession(); }

  /** Replace the selected transcript and follow the session.
   * @param sessionId - Session to follow.
   */
  private async selectSession(sessionId: string): Promise<void> { await this.session.selectSession(sessionId); }

  /** Wait for the selected follow snapshot.
   * @param signal - Cancels waiting without closing the session.
   */
  private async waitForHistory(signal: AbortSignal): Promise<void> { await this.session.waitForHistory(signal); }

  /** Search host session results.
   * @param query - Literal message text.
   * @param workspaceOnly - Restrict hits to the selected workspace.
   * @param signal - Cancels the HTTP search.
   * @returns Session snippets and the global truncation flag.
   */
  private async searchSessions(query: string, workspaceOnly: boolean, signal: AbortSignal): Promise<{ items: ObjectValue[]; hasMore: boolean }> {
    return this.session.searchSessions(query, workspaceOnly, signal);
  }

  /** Search host paths for the composer's `@` completion.
   * @param query - Path text after @.
   * @param signal - Cancels an obsolete lookup.
   * @returns Validated candidates in host order.
   */
  private async references(query: string, signal: AbortSignal) { return this.session.references(query, signal); }

  /** Execute a human command directly, outside the model prompt queue.
   * @param line - Complete slash command, including arguments.
   * @param signal - Cancels the request while the host performs compaction.
   * @returns The host's successful command result text.
   */
  private async command(line: string, signal: AbortSignal): Promise<string> { return this.session.command(line, signal); }

  /** Remove one host-owned pending input.
   * @param itemId - Queue occurrence identity from session/control.
   */
  private async removeQueued(itemId: string): Promise<void> { await this.session.removeQueued(itemId); }

  /** Export the selected host log to a new local ZIP file.
   * @param path - Optional local destination; existing files are never overwritten.
   * @param signal - Cancels the download and removes an incomplete file.
   * @returns Absolute saved filename.
   */
  private async exportLog(path: string | undefined, signal: AbortSignal): Promise<string> { return this.session.exportLog(path, signal); }

  /** Save loaded Markdown, diagrams and math as offline HTML.
   * @param path - Optional filename; existing files are not replaced.
   * @param signal - Cancels the write.
   * @returns Absolute saved filename.
   */
  private async exportHtml(path: string | undefined, signal: AbortSignal): Promise<string> { return this.session.exportHtml(path, signal); }

  /** Write a V8 heap snapshot into this client's working directory; the write pauses the client.
   * @param tag - Sampling-point label naming the file, such as `after-stress`.
   * @returns Absolute path of the written snapshot.
   */
  private heapSnapshot(tag?: string): string { return writeHeapSnapshot(process.cwd(), tag); }

  /** Admit text once as steering while running, or a new turn while idle.
   * @param text - Composed prompt text.
   */
  private async prompt(text: string): Promise<void> { await this.session.prompt(text); }

  /** Cancel the active turn; pending queue items remain host-owned. */
  private async cancelTurn(): Promise<void> { await this.session.cancelTurn(); }

  /** Add a page before the retained window.
   * @param signal - Cancels local paging without interrupting the remote agent.
   * @param transcript - Transcript to extend; defaults to the live one.
   */
  private async older(signal?: AbortSignal, transcript?: Transcript): Promise<void> { await this.session.older(signal, transcript); }

  /** Search the loaded history page by page.
   * @param query - Literal, case-insensitive text including folded reasoning.
   * @param signal - Cancels HTTP and processing without cancelling the agent.
   * @returns Newest-first bounded summaries and an explicit truncation flag.
   */
  private async searchHistory(query: string, signal: AbortSignal): Promise<HistorySearch> { return this.session.searchHistory(query, signal); }

  /** Load a separate small window ending at a search target.
   * @param target - Durable message sequence to display.
   * @param signal - Cancels the target-page request.
   * @returns A caller-owned historical window that must be disposed when closed.
   */
  private async historyAt(target: number, signal: AbortSignal): Promise<Transcript> { return this.session.historyAt(target, signal); }

  /** Plain rows and offsets for one laid-out record; the projection stays in the session domain. */
  private render(input: { transcript: Transcript; width: number; folds: ReadonlySet<number>; liveReasoning: Reasoning }): SessionRender {
    return this.session.render(input);
  }

  /** Load the prefix required for an explicit history jump.
   * @param target - Visible record sequence, or first for the oldest available history.
   * @param signal - Cancels local paging without interrupting the remote agent.
   */
  private async historyThrough(target: number | 'first', signal: AbortSignal): Promise<void> { await this.session.historyThrough(target, signal); }

  /** Answer the oldest selected-session interaction, after explicit user action.
   * @param value - Structured answer collected by the UI.
   */
  private async answer(value: AnswerValue): Promise<void> { await this.session.answer(value); }

  /** Approve or reject the pending approval request.
   * @param allowed - Whether the request is approved once.
   */
  private async approve(allowed: boolean): Promise<void> { await this.session.approve(allowed); }

  /** Dismiss the whole pending question set without answering it, as the Web close button does. */
  private async dismissQuestion(): Promise<void> { await this.session.dismissQuestion(); }
}

export type { HistorySearch, RemovalTarget, AnswerValue, PendingInteraction } from '../session/types.ts';
export type { State } from '../state.ts';
