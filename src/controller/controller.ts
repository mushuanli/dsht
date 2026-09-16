/** Application facade: composes the connection, session, catalog and cost domains. */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '../transport/client.ts';
import { removeFile, writeHeapSnapshot } from '../storage/index.ts';
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
import { PromptStore } from './prompts.ts';
import { latestAssistantText, parseLoopResult, ScoredLoop, type LoopLimits, type LoopProtocol, type LoopResult, type PriorVerdict } from './loop.ts';
import { findingsLines } from './loop-contract.ts';
import { verificationId, verdictFile, type VerifierOutcome, type VerifierPort } from './verifier.ts';
import type { LoopProgress } from '../contracts.ts';
import { clearReactMeasures, measureCount } from './perf-measures.ts';
import { initialState, type ControllerStore, type State } from '../state.ts';
import { ShellController } from '../shell/index.ts';
import type { HistorySearch, AnswerValue, RemovalTarget } from '../session/types.ts';
import type { SavedPrompt } from '../contracts.ts';
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

/** How many times a verifier outage is retried before the run reports verification unavailable. */
const VERIFIER_RETRIES = 2;

/** How long a finished turn may take to commit its final assistant message.
 *
 * The host reports the turn idle just before that message reaches the follow stream, so a single
 * parse can miss the result block that decides the attempt. Waiting too long only delays a reply
 * that never complies, while deciding too early spends an attempt the reviewer never got.
 */
const LOOP_SETTLE_GRACE_MS = 4000;

/** File `/handoff` clears on this machine before it asks the agent to write a handoff. */
const HANDOFF_FILE = 'HANDOFF.md';

/** Instruction `/handoff` sends once this client's own copy of the file is gone.
 *
 * The sections are explicit because a handoff is read by whoever continues the work: why the
 * session exists, the goal, and the state of every task, including the ones that cannot be done.
 */
const HANDOFF_PROMPT = [
  'Write a session handoff to HANDOFF.md in the workspace root, overwriting whatever is there,',
  'in the language of this conversation. Cover, in this order:',
  '(1) why this session exists and what triggered it;',
  '(2) the goal it is working toward;',
  '(3) every task and its state — completed, still open, or impossible, each with its reason;',
  '(4) the decisions made and the files changed;',
  '(5) how to verify the current state;',
  '(6) the exact next steps for whoever continues this work.',
  'Base it only on this session; never invent work that did not happen.',
].join(' ');

/** Mutating operations the UI drives; each owns its busy/error envelope. */
export interface Actions {
  switchWorkspace(workspaceId?: string): Promise<boolean>;
  switchSession(query?: string): Promise<boolean>;
  selectSession(sessionId: string): Promise<boolean>;
  createWorkspace(path: string): Promise<boolean>;
  createSession(): Promise<boolean>;
  /** Create a named session without selecting it; used by a forked verifier. */
  createVerifierSession(title: string): Promise<string | undefined>;
  /** Stop a verifier session's turn on the host without selecting it. */
  cancelVerifierSession(sessionId: string): Promise<boolean>;
  showPicker(screen: 'workspaces' | 'sessions'): Promise<boolean>;
  removeTarget(target: RemovalTarget): Promise<boolean>;
  removalTarget(kind: 'workspace' | 'session', query: string): Promise<RemovalTarget | undefined>;
  waitForHistory(signal: AbortSignal): Promise<boolean>;
  searchSessions(query: string, workspaceOnly: boolean, signal: AbortSignal): Promise<{ items: ObjectValue[]; hasMore: boolean } | undefined>;
  searchHistory(query: string, signal: AbortSignal): Promise<HistorySearch | undefined>;
  prompt(text: string): Promise<boolean>;
  /** Clear this client's HANDOFF.md, then ask the agent to write a fresh handoff there. */
  handoff(): Promise<boolean>;
  /** Start any client-driven scored loop and send its first step. */
  startLoop(protocol: LoopProtocol, limits: LoopLimits): Promise<boolean>;
  /** Stop a running loop; the terminal progress stays visible for the reader. */
  stopLoop(): void;
  /** Set or clear the session's verification standard read by the next loop. */
  setVerification(criteria?: string): void;
  cancelTurn(): Promise<boolean>;
  answer(value: AnswerValue): Promise<boolean>;
  approve(allowed: boolean): Promise<boolean>;
  dismissQuestion(): Promise<boolean>;
  /** Repeated keys share one cancellation; it reports exit eligibility itself. */
  interrupt(force?: boolean): Promise<boolean>;
  older(signal?: AbortSignal, transcript?: Transcript): Promise<boolean>;
  historyThrough(target: number | 'first', signal: AbortSignal): Promise<boolean>;
  removeQueued(itemId: string): Promise<boolean>;
  /** Local shortcut prompts: no connection and no busy envelope, since they never reach the host. */
  savePrompt(text: string): Promise<boolean>;
  updatePrompt(id: string, text: string): Promise<boolean>;
  deletePrompt(id: string): Promise<boolean>;
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
  /** Turns the selected session has finished since this client connected. */
  readonly turnsCompleted: number;
  /** Whether a forked verifier is available to score rounds. */
  readonly forkedVerification: boolean;
  /** Whether this connection generation finished its startup work and is safe to drive. */
  readonly connectionSettled: boolean;
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
  /** Shortcut prompts the operator saved, oldest first. */
  readonly prompts: readonly SavedPrompt[];
  /** Live progress of the selected session's design review, when one has run. */
  readonly loop: LoopProgress | undefined;
  /** Standard the next loop must be verified against, when the operator set one. */
  readonly verification: string | undefined;
  /** Why the saved prompts could not be read, when the file was malformed. */
  readonly promptsError: string | undefined;
  pendingCounts(): ReadonlyMap<string, number>;
  recall(direction: -1 | 1, current: string): string;
  references(query: string, signal: AbortSignal): Promise<FileReference[]>;
  historyAt(target: number, signal: AbortSignal): Promise<Transcript>;
  /** Plain rows and offsets for one laid-out record. */
  render(input: { transcript: Transcript; width: number; folds: ReadonlySet<number>; liveReasoning: Reasoning }): SessionRender;
}

/** Everything one `Controller` needs, named so a new capability never shifts an argument position.
 *
 * `base` is the only required field: a local or offline client still has an address to show, while
 * every other capability — authentication, billing, budgets, local shell, shortcut prompts — is
 * opted into by supplying its own field.
 */
export interface ControllerOptions {
  /** Host base URL. */
  base: string;
  /** Token for the first authentication; absent when a saved cookie already authenticates. */
  token?: string;
  /** Session to open once connected, instead of starting on the picker. */
  initialSession?: string;
  /** Builds one connection client; defaults to a plain `Client` for `base`. */
  makeClient?: () => Client;
  /** Authenticates one connection client; defaults to the supplied token. */
  authenticate?: (client: Client) => Promise<void>;
  /** Billing ledger; absent disables every cost feature. */
  costs?: CostLedger;
  /** History retention budgets. */
  historyLimits?: HistoryLimits;
  /** Runtime memory log path; absent disables the log. */
  memoryLogPath?: string;
  /** Directory this client runs in, offered as a workspace the host has not registered. */
  localDirectory?: string;
  /** Whether `!` may run local commands; the CLI disables it with `--no-shell`. */
  shellEnabled?: boolean;
  /** File holding the operator's shortcut prompts; absent keeps them in memory for this run. */
  promptsPath?: string;
  /** Independent verifier for scored rounds; absent keeps verification inside the reviewed session. */
  verifier?: VerifierPort;
  /** Allow a reply block to decide when the verifier is unavailable; the progress line says so. */
  allowSelfFallback?: boolean;
  /** Client-side root for verdict files; defaults to the workspace this client runs in. */
  verdictRoot?: string;
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
  /** Shortcut prompts the operator saved; in memory for this run when no path was supplied. */
  readonly promptStore: PromptStore;
  /** Running agent loop, if any; the loop lives here, not in the UI. */
  private loop?: ScoredLoop;
  /** Prompt the loop still has to send, when it could not be sent immediately. */
  private loopPrompt?: string;
  /** Verification standard for this session, read when a loop starts. */
  private verification?: string;
  /** Finished turns of the selected session, so a waiter never has to sample a cached flag. */
  private completedTurns = 0;
  /** Sessions the host reported busy, so a lone idle frame cannot claim a finished turn. */
  private readonly busySessions = new Set<string>();
  /** When the in-flight attempt's turn ended, while its result block is still awaited. */
  private loopEndedAt?: number;
  /** Timer that settles an attempt whose reply never commits its result block. */
  private loopSettleTimer?: NodeJS.Timeout;
  /** Whether an attempt is currently being judged by an independent verifier. */
  private loopVerifying = false;
  /** Cancels that verification when the loop is stopped or replaced. */
  private loopVerifyAbort?: AbortController;
  /** Verdict of the previous attempt on the current step, for the retry and the next verifier. */
  private loopPrevious?: PriorVerdict;
  /** Identity of the run in flight, so its verdicts are isolated from every other run's. */
  private loopRunId?: string;
  /** Consecutive verifier outages in this attempt, so a broken verifier is retried then reported. */
  private loopVerifierMisses = 0;
  /** Whether a reply block may stand in for a missing verdict; off unless asked for. */
  private readonly allowSelfFallback: boolean;
  /** Client-side directory verdict files are written under. */
  private readonly verdictRoot: string;
  /** Local `!` commands, run on this machine and shown inline in the transcript. */
  readonly shell: ShellController;
  /** Mutating surface the UI drives. */
  readonly actions: Actions;
  /** Read-only surface the UI drives. */
  readonly queries: Queries;
  /** Host base URL this client talks to. */
  readonly base: string;
  /** Billing ledger supplied at construction, when any. */
  readonly costs: CostLedger | undefined;
  /** History retention budgets in force. */
  readonly historyLimits: HistoryLimits;
  /** Runtime memory log path, when one was configured. */
  readonly memoryLogPath: string | undefined;
  /** Directory this client runs in. */
  readonly localDirectory: string;
  /** Independent verifier for scored rounds, when one was supplied. */
  private readonly verifier: VerifierPort | undefined;
  /** Session opened at startup, when one was named. */
  private readonly initialSession: string | undefined;
  private readonly observers = new Set<() => void>();
  private selector = 0;
  private connectionSettled = false;

  constructor(options: ControllerOptions) {
    const { base, token, initialSession, costs } = options;
    const makeClient = options.makeClient ?? (() => new Client(base));
    const authenticate = options.authenticate ?? (client => client.authenticate(token ?? ''));
    const historyLimits = options.historyLimits ?? DEFAULT_HISTORY_LIMITS;
    const shellEnabled = options.shellEnabled ?? true;
    this.base = base; this.costs = costs; this.historyLimits = historyLimits;
    this.memoryLogPath = options.memoryLogPath; this.localDirectory = options.localDirectory ?? process.cwd();
    this.initialSession = initialSession;
    this.verifier = options.verifier;
    this.allowSelfFallback = options.allowSelfFallback === true;
    this.verdictRoot = options.verdictRoot ?? this.localDirectory;
    const connectionOptions: ConnectionOptions = { base, token, initialSession, makeClient, authenticate };
    this.connection = new ConnectionController(this, connectionOptions, this);
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
    if (this.memoryLogPath !== undefined) this.memoryLog = new MemoryLog(this.memoryLogPath, () => this.memorySample());
    this.promptStore = new PromptStore(options.promptsPath);
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
    // A loop and its verification standard belong to one session: selecting a different session ends
    // them, but a reconnect — which transiently clears the selection — must not, or a long review
    // could never finish.
    if (next.sessionId !== undefined && next.sessionId !== this.state.sessionId && this.loop?.sessionId !== next.sessionId) {
      this.forgetLoop();
      this.verification = undefined;
    }
    this.state = next;
    for (const observer of this.observers) observer();
    // A prompt the loop could not send yet (offline, busy or answering) goes out as soon as it can.
    if (this.loopPrompt !== undefined) void this.flushLoop();
    // A finished attempt whose reply is still committing gets another look on every publish.
    if (this.loopEndedAt !== undefined) this.trySettleLoop();
  }

  /** Bind every mutating entry point to its private implementation. */
  private buildActions(): Actions {
    return {
      switchWorkspace: id => this.runAction(() => this.switchWorkspace(id)),
      switchSession: query => this.runAction(() => this.switchSession(query)),
      selectSession: id => this.runAction(() => this.selectSession(id)),
      createWorkspace: path => this.runAction(() => this.createWorkspace(path)),
      createSession: () => this.runAction(() => this.createSession()),
      createVerifierSession: title => this.runActionValue(() => this.session.createNamedSession(title)),
      cancelVerifierSession: sessionId => this.runAction(() => this.session.cancelNamedSession(sessionId)),
      showPicker: screen => this.runAction(() => this.showPicker(screen)),
      removeTarget: target => this.runAction(() => this.removeTarget(target)),
      removalTarget: (kind, query) => this.runActionValue(() => this.removalTarget(kind, query)),
      waitForHistory: signal => this.runAction(() => this.waitForHistory(signal)),
      searchSessions: (query, workspaceOnly, signal) => this.runActionValue(() => this.searchSessions(query, workspaceOnly, signal)),
      searchHistory: (query, signal) => this.runActionValue(() => this.searchHistory(query, signal)),
      prompt: text => this.runAction(() => this.prompt(text)),
      handoff: () => this.runAction(() => this.handoff()),
      startLoop: (protocol, limits) => this.runAction(() => this.startLoop(protocol, limits)),
      stopLoop: () => this.stopLoop(),
      setVerification: criteria => this.setVerification(criteria),
      cancelTurn: () => this.runAction(() => this.cancelTurn()),
      answer: value => this.runAction(() => this.answer(value)),
      approve: allowed => this.runAction(() => this.approve(allowed)),
      dismissQuestion: () => this.runAction(() => this.dismissQuestion()),
      interrupt: force => this.interrupt(force),
      older: (signal, transcript) => this.runAction(() => this.older(signal, transcript)),
      historyThrough: (target, signal) => this.runAction(() => this.historyThrough(target, signal)),
      removeQueued: itemId => this.runAction(() => this.removeQueued(itemId)),
      savePrompt: text => this.runLocalAction(async () => {
        await this.promptStore.save(text); this.update({ operation: { ...this.state.operation, error: '' } });
      }),
      updatePrompt: (id, text) => this.runLocalAction(async () => {
        if (!await this.promptStore.update(id, text)) throw new Error('That saved prompt no longer exists');
        this.update({ operation: { ...this.state.operation, error: '' } });
      }),
      deletePrompt: id => this.runLocalAction(async () => {
        if (!await this.promptStore.remove(id)) throw new Error('That saved prompt no longer exists');
        this.update({ operation: { ...this.state.operation, error: '' } });
      }),
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
      get turnsCompleted() { return controller.completedTurns; },
      get forkedVerification() { return controller.verifier !== undefined; },
      get connectionSettled() { return controller.connectionSettled; },
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
      get prompts() { return controller.promptStore.list; },
      get promptsError() { return controller.promptStore.error; },
      get loop() { return controller.loop?.progress; },
      get verification() { return controller.verification; },
      pendingCounts: () => controller.pendingCounts(),
      recall: (direction, current) => controller.recall(direction, current),
      references: (query, signal) => controller.references(query, signal),
      historyAt: (target, signal) => controller.historyAt(target, signal),
      render: input => controller.render(input),
    };
  }

  /** Start one retry loop, with a fresh snapshot generation after every disconnect. */
  start(): void {
    this.connection.start();
    this.memoryLog?.start();
    // Reading the shortcuts file is local and may finish after the first paint. Nothing is
    // republished for an empty list: the picker reads the live list when it opens, so a load that
    // found nothing must not add a render to an unrelated interaction.
    void this.promptStore.load().then(changed => { if (changed) this.update({}); });
  }

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

  /** Run one local operation that needs no connection, reporting failure the way `runAction` does.
   *
   * Shortcut prompts are the operator's own file, so they must keep working while the host is
   * disconnected; only the failure line is shared with the remote operations.
   * @param operation - Operation to run against local storage.
   * @returns Whether it ran to completion.
   */
  private async runLocalAction(operation: () => Promise<void>): Promise<boolean> {
    try { await operation(); return true; }
    catch (error) { this.update({ operation: { ...this.state.operation, error: errorText(error) } }); return false; }
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
    this.connectionSettled = false;
    // A busy state does not survive the connection it was observed on.
    this.busySessions.clear();
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
    // A loop outlives a reconnect, so it re-attaches to its own session even when the picker
    // replaced the selection; without that the loop would keep settling against an empty transcript.
    const looping = this.loop?.sessionId;
    const sessionId = this.state.sessionId ?? looping ?? this.initialSession;
    if (sessionId && (screen === 'chat' || looping !== undefined || this.initialSession && !this.state.sessionId)) {
      await this.session.selectSession(sessionId);
    }
    // `online` means the socket works; `connectionSettled` means the picker and the selection are
    // done, which is what an automation caller must wait for or it races `showPicker`.
    this.connectionSettled = true;
    this.update({});
    this.cost?.start();
  }

  /** The generation ended; invalidate session work and stop the scan.
   *
   * A running loop is deliberately left alone: the host keeps running the review, and the client
   * re-selects the same session after reconnecting, so only a switch to another session ends it.
   */
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
        if (event.running) this.busySessions.add(event.sessionId);
        else {
          // Only a turn this client watched start counts as finished. A replayed or duplicated idle
          // frame would otherwise look like a prompt completing, which `--wait` would trust.
          const started = this.busySessions.delete(event.sessionId);
          if (started && event.sessionId === this.state.sessionId) this.completedTurns += 1;
          this.cost?.onTurnIdle();
          this.settleLoop(event.sessionId);
        }
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
  private interrupt(force = false): Promise<boolean> {
    // Esc and Ctrl+C stop the automated loop as well as the turn; otherwise it would keep sending.
    this.stopLoop();
    return this.session.interrupt(force);
  }

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
   *
   * Text the operator typed ends an automated review: the loop must not race a human for the turn,
   * and the reply it would parse is no longer the reply to its own prompt.
   * @param text - Composed prompt text.
   */
  private async prompt(text: string): Promise<void> {
    this.stopLoop();
    await this.session.prompt(text);
  }

  /** Clear this client's stale handoff file, then ask the agent to write a new one.
   *
   * The deletion happens first and on this machine, so a handoff that never gets written cannot be
   * mistaken for the previous one. The request itself is an ordinary turn: it steers a running
   * agent and starts an idle one, exactly like submitted text.
   */
  private async handoff(): Promise<void> {
    await removeFile(join(this.localDirectory, HANDOFF_FILE));
    await this.session.promptInternal(HANDOFF_PROMPT);
  }

  /** Start a scored loop and send its opening step.
   * @param protocol - Prompt text and step count the loop follows.
   * @param limits - Resolved `--from/--to/--score/--tries`.
   */
  private async startLoop(protocol: LoopProtocol, limits: LoopLimits): Promise<void> {
    const sessionId = this.state.sessionId;
    if (sessionId === undefined) throw new Error('Select a session first');
    this.forgetLoop();
    const loop = new ScoredLoop(sessionId, protocol, limits);
    const prompt = loop.start();
    loop.sent();
    this.loop = loop;
    this.update({});
    try { await this.session.promptInternal(prompt); }
    catch (error) { this.forgetLoop(); this.update({}); throw error; }
  }

  /** Stop a running review; the terminal progress stays visible for the reader. */
  private stopLoop(): void {
    if (this.loop === undefined) return;
    this.forgetSettleTimer();
    this.abortVerification();
    this.loopEndedAt = undefined;
    this.loop.cancel();
    this.loopPrompt = undefined;
    this.update({});
  }

  /** Replace this session's verification standard; the next loop reads it at start. */
  private setVerification(criteria?: string): void {
    this.verification = criteria;
    this.update({});
  }

  /** Drop the loop entirely, without publishing a cancelled phase. */
  private forgetLoop(): void {
    this.forgetSettleTimer();
    this.abortVerification();
    this.loopPrevious = undefined;
    this.loopRunId = undefined;
    this.loopVerifierMisses = 0;
    this.loop = undefined;
    this.loopPrompt = undefined;
    this.loopEndedAt = undefined;
  }

  /** Note that an attempt's turn ended; its block may still be arriving.
   * @param sessionId - Session the host reported idle.
   */
  private settleLoop(sessionId: string): void {
    const loop = this.loop;
    if (loop === undefined || !loop.active || !loop.settled || loop.sessionId !== sessionId) return;
    this.loopEndedAt ??= Date.now();
    this.trySettleLoop();
  }

  /** Consume the attempt once its result block is committed, or the grace period expires.
   *
   * The final assistant message can land a moment after the idle event, so an empty parse is not yet
   * a failed attempt: the next publish retries, and one timer covers a transcript that never grows.
   */
  private trySettleLoop(): void {
    const loop = this.loop;
    if (loop === undefined || !loop.active || !loop.settled) { this.forgetSettleTimer(); this.loopEndedAt = undefined; return; }
    // Only a turn that actually ended may be consumed: a timer that fired just before the attempt
    // settled must not decide the attempt that replaced it.
    const endedAt = this.loopEndedAt;
    if (endedAt === undefined) { this.forgetSettleTimer(); return; }
    // An independent verifier decides the round; the reply block below stays as its fallback.
    if (loop.protocol.verify !== undefined && this.verifier !== undefined) {
      if (!this.loopVerifying) void this.verifyRound(loop);
      return;
    }
    const result = parseLoopResult(latestAssistantText(this.state.session.record.messages), loop.protocol);
    if (result === undefined && Date.now() - endedAt < LOOP_SETTLE_GRACE_MS) {
      if (this.loopSettleTimer === undefined) {
        this.loopSettleTimer = setTimeout(() => { this.loopSettleTimer = undefined; this.trySettleLoop(); }, LOOP_SETTLE_GRACE_MS);
        this.loopSettleTimer.unref();
      }
      return;
    }
    this.forgetSettleTimer();
    this.loopEndedAt = undefined;
    this.settleWith(loop, result);
  }

  /** Score one finished round out of band, in a process of its own.
   *
   * The child writes its verdict to a file, so a slow or failed verifier delays the attempt instead
   * of corrupting it: with no verdict the reply block decides, and with neither the attempt fails.
   * @param loop - The run whose attempt just finished.
   */
  private async verifyRound(loop: ScoredLoop): Promise<void> {
    const verifier = this.verifier;
    if (verifier === undefined) return;
    const { step, attempt } = loop.progress;
    const { kind } = loop.protocol;
    const runId = this.loopRunId ?? (this.loopRunId = randomUUID());
    const file = verdictFile(this.verdictRoot, runId, kind, step, attempt);
    const identity = verificationId(runId, kind, step, attempt);
    const prompt = loop.protocol.verify!(loop.progress, step, attempt, { file, verificationId: identity }, this.loopPrevious);
    this.loopVerifying = true;
    const abort = new AbortController();
    this.loopVerifyAbort = abort;
    let outcome: VerifierOutcome;
    try {
      outcome = await verifier.verify({ verificationId: identity, kind, step, attempt, prompt, file,
        ...(loop.protocol.artifact === undefined ? {} : { artifact: loop.protocol.artifact }),
        title: `[dsht-verify] ${loop.protocol.title} · ${step}/${attempt}` }, abort.signal);
    } catch (error) {
      outcome = { type: 'unavailable', reason: `verifier failed: ${errorText(error)}` };
    } finally {
      if (this.loopVerifyAbort === abort) this.loopVerifyAbort = undefined;
      this.loopVerifying = false;
    }
    // Verification outlives nothing: a cancelled or replaced loop must not be settled by its result.
    if (this.loop !== loop || !loop.active || !loop.settled) return;
    this.forgetSettleTimer();
    this.loopEndedAt = undefined;
    // The review was cancelled: nothing to decide, and nothing to report as a verdict.
    if (outcome.type === 'cancelled') return;
    if (outcome.type === 'verified') { this.loopVerifierMisses = 0; this.settleWith(loop, outcome.result); return; }

    // Unavailable is not a verdict, so it never consumes the attempt: retry the verifier, and only
    // then stop the run. Self-scoring is opt-in and is always visible in the progress line.
    this.loopVerifierMisses += 1;
    if (this.loopVerifierMisses <= VERIFIER_RETRIES) {
      loop.note(`⚠ verification unavailable · retrying (${outcome.reason})`);
      this.update({});
      void this.verifyRound(loop);
      return;
    }
    if (this.allowSelfFallback) {
      const fallback = parseLoopResult(latestAssistantText(this.state.session.record.messages), loop.protocol);
      this.settleWith(loop, fallback, fallback === undefined
        ? `⚠ verification fallback · self-reported (and no reply block: ${outcome.reason})`
        : '⚠ verification fallback · self-reported');
      return;
    }
    loop.note(`⚠ verification unavailable · ${outcome.reason}`);
    loop.unavailable();
    this.update({});
  }

  /** Apply one attempt's verdict, and continue the run when it has a next step.
   * @param loop - The run being settled.
   * @param result - Verdict to consume, or undefined when the attempt produced none.
   */
  private settleWith(loop: ScoredLoop, result: LoopResult | undefined, note = ''): void {
    const before = loop.progress;
    const step = loop.settle(result);
    // The note describes the attempt just decided, so it is applied after the state moved on.
    loop.note(note);
    if (step.kind === 'continue') {
      // A retry on the same step carries the verdict that caused it; a new step starts clean.
      this.loopPrevious = before.step === loop.progress.step && result !== undefined
        ? { step: before.step, attempt: before.attempt, result } : undefined;
      const findings = result === undefined ? [] : findingsLines(result);
      this.loopPrompt = [step.prompt, ...findings].join('\n');
    }
    this.update({});
    if (step.kind === 'continue') void this.flushLoop();
  }

  /** Stop an in-flight verification, if any; its result can no longer decide anything. */
  private abortVerification(): void {
    this.loopVerifyAbort?.abort();
    this.loopVerifyAbort = undefined;
    this.loopVerifying = false;
  }

  /** Drop a pending settle timer, if any. */
  private forgetSettleTimer(): void {
    if (this.loopSettleTimer === undefined) return;
    clearTimeout(this.loopSettleTimer);
    this.loopSettleTimer = undefined;
  }

  /** Send the prompt the loop is holding, once the client can actually send it. */
  private async flushLoop(): Promise<void> {
    const loop = this.loop;
    const prompt = this.loopPrompt;
    if (loop === undefined || prompt === undefined || !loop.active) return;
    if (this.state.sessionId !== loop.sessionId) return;
    if (!this.state.online || this.state.operation.busy || this.state.pending.length) return;
    // Consume before awaiting, so a re-entrant update cannot send the same prompt twice.
    this.loopPrompt = undefined;
    loop.sent();
    this.update({});
    try { await this.session.promptInternal(prompt); }
    catch (error) {
      this.forgetLoop();
      this.update({ operation: { ...this.state.operation, error: errorText(error) } });
    }
  }

  /** Cancel the active turn; pending queue items remain host-owned. */
  private async cancelTurn(): Promise<void> {
    this.stopLoop();
    await this.session.cancelTurn();
  }

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
export type { SavedPrompt } from '../contracts.ts';
export type { State } from '../state.ts';
