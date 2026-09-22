/** Application facade: composes the connection, session, catalog and cost domains. */
import { join } from 'node:path';
import { Client } from '../transport/client.ts';
import { removeFile, writeHeapSnapshot } from '../storage/index.ts';
import { errorText, string, type Json, type ObjectValue } from '../transport/wire.ts';
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
import { ForegroundSlot } from './foreground.ts';
import { TraceLog } from './trace-log.ts';
import { PromptStore } from './prompts.ts';
import { latestAssistantText, type LoopLimits, type LoopProtocol } from './loop.ts';
import { LoopCoordinator } from './loop-coordinator.ts';
import { loopRecords as listLoopRecords } from './loop-protocols.ts';
import type { VerifierPort } from './verifier.ts';
import type { ClientActivity, ForegroundKind, ForegroundSnapshot, LoopProgress, LoopRecord, OutputSource, PeekSnapshot } from '../contracts.ts';
import { SessionPeek } from '../session/peek.ts';
import { costAddresses } from '../cost/scanner.ts';
import { sessionLabel } from '../session-title.ts';
import { clearReactMeasures, measureCount } from './perf-measures.ts';
import { initialState, type ControllerStore, type State } from '../state.ts';
import { ShellController, localSourceId } from '../shell/index.ts';
import type { HistorySearch, AnswerValue, RemovalTarget } from '../session/types.ts';
import type { SavedPrompt } from '../contracts.ts';
import type { FileReference } from '../session/references.ts';
import type { InteractionState, OptionState } from '../session/info.ts';
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

/** Sources this client registers before it forgets the oldest; a session list can still find them. */
const SOURCE_LIMIT = 50;

/** The tag every verifier session title starts with, so a reader can tell it apart in a list. */
const VERIFIER_TAG = '[dsht-verify] ';

/** What the read-only view calls a verifier's session: its title without the marker prefix. */
function verifierLabel(title: string): string {
  const stripped = title.startsWith(VERIFIER_TAG) ? title.slice(VERIFIER_TAG.length) : title;
  return stripped.trim() === '' ? title : stripped.trim();
}

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

/** Mutating operations: foreground work, local edits, and control cancellation with its own admission. */
export interface Actions {
  /** Claim the single foreground slot for work the front end orchestrates itself (paging, loading).
   *
   * The controller owns the slot, the abort controller and the identity; the front end only supplies
   * the work and renders `queries.foreground`. Returns undefined when the client is busy with another
   * operation or the client has stopped. Admitted work keeps its result/error on cancellation.
   */
  foreground<T>(kind: ForegroundKind, label: string, work: (signal: AbortSignal) => Promise<T>, wait?: boolean): Promise<T | undefined>;
  /** Cancel the operation that owns the slot; false when none is running. */
  cancelForeground(): boolean;
  /** Open one output source read-only, at full screen; unknown ids are ignored. */
  openPeek(id: string): void;
  /** Close the read-only view and release whatever it was following. */
  closePeek(): void;
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
  /** Drop a finished run's progress line; a run that is still active is left alone. */
  clearLoopResult(): void;
  /** Answer a paused run: re-judge the current artifact with what the operator supplied. */
  answerLoop(text: string): Promise<boolean>;
  cancelTurn(): Promise<boolean>;
  answer(value: AnswerValue): Promise<boolean>;
  /** Answer the current sub-question of the pending set, advancing the waterfall or sending it. */
  answerQuestion(input?: { selected?: readonly string[]; custom?: string }): Promise<boolean>;
  approve(allowed: boolean): Promise<boolean>;
  dismissQuestion(): Promise<boolean>;
  /** Repeated keys share one cancellation; it reports exit eligibility itself. */
  interrupt(force?: boolean): Promise<boolean>;
  older(signal?: AbortSignal, transcript?: Transcript): Promise<boolean>;
  openHistory(target: number, signal: AbortSignal): Promise<boolean>;
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
  /** Drop the internal last failure, once the fact has been reported elsewhere. */
  clearFailure(): void;
  enterPath(): void;
  pickWorkspace(workspaceId?: string): void;
  /** Leave a picker and return to the selected conversation; false when none is selected. */
  showChat(): boolean;
  showLatest(): void;
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
  /** Whether this client's own reply block may decide an attempt: no verifier, or the fallback is on. */
  readonly selfScoring: boolean;
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
  /** What the client is working on now, already merged across the host turn and any running loop. */
  readonly activity: ClientActivity | undefined;
  /** The one operation that owns the client, when one does; the view renders its label and clock. */
  readonly foreground: ForegroundSnapshot | undefined;
  /** Every readable output source this client knows: verifier sessions, `!` runs, host children. */
  readonly sources: readonly OutputSource[];
  /** The read-only view's content, when one is open; undefined while it is closed. */
  readonly peek: PeekSnapshot | undefined;
  /** Every `loop.yaml` record, so the picker can offer names and their defaults without a lookup. */
  readonly loopRecords: readonly LoopRecord[];
  /** Why the saved prompts could not be read, when the file was malformed. */
  readonly promptsError: string | undefined;
  pendingCounts(): ReadonlyMap<string, number>;
  recall(direction: -1 | 1, current: string): string;
  references(query: string, signal: AbortSignal): Promise<FileReference[]>;

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
  /** Connection, screen and selection trace path; absent disables the log. */
  tracePath?: string;
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
  /** Whole-run budget in milliseconds; when it expires the run stops as `deadline`. */
  deadlineMs?: number;
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
  /** Bounded connection, screen and selection trace; present only when a path was supplied. */
  readonly trace: TraceLog | undefined;
  /** Shortcut prompts the operator saved; in memory for this run when no path was supplied. */
  readonly promptStore: PromptStore;
  /** Finished turns of the selected session, so a waiter never has to sample a cached flag. */
  private completedTurns = 0;
  /** Sessions the host reported busy, so a lone idle frame cannot claim a finished turn. */
  private readonly busySessions = new Set<string>();
  /** Loop execution owns all verifier, settling and deadline state. */
  private readonly loops: LoopCoordinator;
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
  /** Session opened at startup, when one was named. */
  private readonly initialSession: string | undefined;
  private readonly observers = new Set<() => void>();
  private selector = 0;
  private connectionSettled = false;
  /** Startup defaults apply once; subsequent generations restore the operator's selection. */
  private initialized = false;
  /** Counter behind `commandId`, so every executed line has one identifier in begin and end. */
  private commandSeq = 0;
  /** Scheduling and cancellation are owned independently of domain operations. */
  private readonly foregroundSlot = new ForegroundSlot({
    changed: started => this.update(started ? { lastFailure: '' } : {}),
    trace: event => this.traceEvent('foreground', event),
  });
  /** Read-only follower for the full-screen view; it borrows the connection and never selects. */
  readonly peek: SessionPeek;
  /** Sources this client created, keyed by session id; the host cannot record that lineage itself. */
  private readonly createdSources = new Map<string, OutputSource>();
  /** The source the read-only view is showing, when one is open. */
  private peekId: string | undefined;

  constructor(options: ControllerOptions) {
    const { base, token, initialSession, costs } = options;
    const makeClient = options.makeClient ?? (() => new Client(base));
    const authenticate = options.authenticate ?? (client => client.authenticate(token ?? ''));
    const historyLimits = options.historyLimits ?? DEFAULT_HISTORY_LIMITS;
    const shellEnabled = options.shellEnabled ?? true;
    this.base = base; this.costs = costs; this.historyLimits = historyLimits;
    this.memoryLogPath = options.memoryLogPath; this.localDirectory = options.localDirectory ?? process.cwd();
    this.initialSession = initialSession;
    this.loops = new LoopCoordinator({
      facts: () => ({ sessionId: this.state.sessionId, online: this.state.online,
        ready: this.state.session.record.ready, busy: this.foregroundSlot.snapshot !== undefined, pending: this.state.pending.length > 0 }),
      reply: () => latestAssistantText(this.state.session.record.messages),
      send: prompt => this.session.promptInternal(prompt),
      publish: failure => this.update(failure === undefined ? {} : { lastFailure: failure }),
      trace: (event, detail) => this.traceEvent(event, detail),
    }, { directory: this.localDirectory, verifier: options.verifier, verdictRoot: options.verdictRoot,
      deadlineMs: options.deadlineMs, allowSelfFallback: options.allowSelfFallback });
    const connectionOptions: ConnectionOptions = { base, token, initialSession, makeClient, authenticate };
    this.connection = new ConnectionController(this, connectionOptions, this);
    // The view follows other sessions over the same connection; it never becomes a second writer.
    this.peek = new SessionPeek(this.connection);
    // Every session write is admitted in order; the trace records that order, which is what answers
    // "who dispatched first" when two mutations of one session compete.
    this.session = new SessionController(this, this.connection, this.connection, historyLimits,
      admission => this.traceEvent('mutation', { session: admission.sessionId, lane: admission.lane, waited: admission.waited }));
    this.shell = new ShellController({
      publish: () => this.update({}),
      cwd: () => this.localDirectory,
      env: () => shellEnv(),
      anchor: () => this.state.session.record.readThrough,
    }, shellEnabled);
    this.catalog = new CatalogController({
      client: () => this.connection.client(), require: () => this.connection.require(),
      online: () => this.state.online, signal: () => this.connection.signal(),
      selection: () => ({ revision: this.selection(), sessionId: this.state.sessionId }),
      publish: patch => this.update(patch),
    });
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
    if (options.tracePath !== undefined) this.trace = new TraceLog(options.tracePath);
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
  /** Whether an operation owns the client's foreground slot right now.
   * @returns True while an operation is running.
   */
  busy(): boolean { return this.foregroundSlot.snapshot !== undefined; }

  update(patch: Partial<State>): void {
    const previous = this.state;
    const next = { ...this.state, ...patch, version: this.state.version + 1 };
    next.pending = next.online && next.screen === 'chat' && this.session
      ? this.session.pendingFor(next.sessionId) : [];
    // The shell service owns its blocks; state carries only the plain snapshot the UI renders.
    if (this.shell) next.shell = this.shell.snapshot();
    // A loop belongs to one session: selecting a different session ends it, but a reconnect — which
    // transiently clears the selection — must not, or a long review could never finish.
    if (next.sessionId !== undefined && next.sessionId !== this.state.sessionId && this.loops.sessionId !== next.sessionId) {
      this.loops.forget();
      // The read-only view belongs to the conversation that opened it; leaving that conversation
      // closes it, and the session switch that follows is never left rendering someone else's rows.
      this.dropPeek();
    }
    this.state = next;
    this.traceTransition(previous, next);
    for (const observer of this.observers) observer();
    this.loops.changed();
  }

  /** Record one diagnostic event; a no-op when no trace path was configured. */
  private traceEvent(event: string, detail: ObjectValue = {}): void {
    this.trace?.record({ event, ...detail });
  }

  /** Record one diagnostic event from outside the controller, such as a UI-only decision.
   *
   * The composition root knows things this class cannot see — which record the operator highlighted,
   * that a form was refused a name — and a start that never reaches `startLoop` is otherwise invisible
   * in every log. Same no-op contract as the internal call.
   * @param event - Event name, e.g. `loop-ui`.
   * @param detail - Identifiers only; never prompt or session text.
   */
  traceNote(event: string, detail: ObjectValue = {}): void {
    this.traceEvent(event, detail);
  }

  /** Mint the identifier one executed line carries through its `begin` and `end` events.
   *
   * Short and process-local on purpose: it exists to pair two lines of one file, not to identify a
   * line across runs, so a monotonic counter beats a random id a reader would have to match by eye.
   * @returns The next command id, such as `C17`.
   */
  nextCommandId(): string {
    this.commandSeq += 1;
    return `C${this.commandSeq}`;
  }

  /** Record the state fields that decide which screen the reader is looking at.
   *
   * Every non-user transition is written here as well as at its cause, so a screen that moved
   * without an expected reason is still visible in the trace rather than silently skipped.
   * @param previous - State before the patch.
   * @param next - State after the patch.
   */
  private traceTransition(previous: State, next: State): void {
    if (this.trace === undefined) return;
    const changed: ObjectValue = {};
    if (previous.screen !== next.screen) changed.screen = `${previous.screen} -> ${next.screen}`;
    if (previous.sessionId !== next.sessionId) changed.session = `${previous.sessionId ?? 'none'} -> ${next.sessionId ?? 'none'}`;
    if (previous.workspaceId !== next.workspaceId) changed.workspace = `${previous.workspaceId ?? 'none'} -> ${next.workspaceId ?? 'none'}`;
    if (previous.online !== next.online) changed.online = next.online;
    if (Object.keys(changed).length > 0) this.traceEvent('state', changed);
  }

  /** Bind every mutating entry point to its private implementation.
   *
   * Each one names the kind and label of the operation it performs, because that is now the single
   * answer to "what owns the client right now" (§6.2): the front end renders it and cancels it, and
   * nothing else has to know which layer started the work.
   */
  private buildActions(): Actions {
    return {
      foreground: (kind, label, work, wait) => this.foregroundSlot.run(kind, label, work, wait),
      cancelForeground: () => this.foregroundSlot.cancel(),
      openPeek: id => this.openPeek(id),
      closePeek: () => this.closePeek(),
      switchWorkspace: id => this.runAction('navigation', 'Switching workspace…', signal => this.switchWorkspace(id, signal)),
      switchSession: query => this.runAction('navigation', 'Switching session…', signal => this.switchSession(query, signal)),
      selectSession: id => this.runAction('navigation', 'Loading session…', () => this.selectSession(id)),
      createWorkspace: path => this.runAction('navigation', 'Registering workspace…', signal => this.createWorkspace(path, signal)),
      createSession: () => this.runAction('navigation', 'Creating session…', signal => this.createSession(signal)),
      createVerifierSession: title => this.runActionValue('verifier', 'Creating verifier session…', () => this.createVerifierSession(title)),
      cancelVerifierSession: sessionId => this.runImmediateAction(async () => {
        await this.session.cancelNamedSession(sessionId);
        // The run is over even though its transcript stays readable; the list should say so.
        this.endSource(sessionId, Date.now());
      }),
      showPicker: screen => this.runAction('picker', 'Listing…', signal => this.showPicker(screen, signal)),
      removeTarget: target => this.runAction('removal', 'Removing…', () => this.removeTarget(target)),
      removalTarget: (kind, query) => this.runActionValue('removal', 'Reading target…', () => this.removalTarget(kind, query)),
      waitForHistory: signal => this.runAction('history', 'Loading history…', () => this.waitForHistory(signal)),
      searchSessions: (query, workspaceOnly, signal) => this.runActionValue('search', 'Searching sessions…', () => this.searchSessions(query, workspaceOnly, signal)),
      openHistory: (target, signal) => this.runAction('history', 'Opening history…', operation => this.session.openHistory(target, AbortSignal.any([signal, operation]))),
      searchHistory: (query, signal) => this.runActionValue('search', 'Searching history…', operation => this.searchHistory(query, AbortSignal.any([signal, operation]))),
      prompt: text => this.runAction('prompt', 'Sending…', () => this.prompt(text)),
      handoff: () => this.runAction('handoff', 'Requesting handoff…', () => this.handoff()),
      startLoop: (protocol, limits) => this.runAction('loop', 'Starting loop…', () => this.loops.start(protocol, limits)),
      stopLoop: () => this.loops.stop(),
      clearLoopResult: () => this.loops.clearResult(),
      answerLoop: text => this.runAction('loop', 'Answering the verifier…', () => this.loops.answer(text)),
      cancelTurn: () => this.runAction('interaction', 'Cancelling…', () => this.cancelTurn()),
      answer: value => this.runAction('interaction', 'Answering…', () => this.answer(value)),
      answerQuestion: input => this.runAction('interaction', 'Answering…', async () => {
        if (!await this.answerQuestion(input)) throw new Error('The answer could not be sent');
      }),
      approve: allowed => this.runAction('interaction', 'Answering…', () => this.approve(allowed)),
      dismissQuestion: () => this.runAction('interaction', 'Dismissing…', () => this.dismissQuestion()),
      interrupt: force => this.interrupt(force),
      older: (signal, transcript) => this.runAction('history', 'Loading history…', operation => this.older(signal === undefined ? operation : AbortSignal.any([signal, operation]), transcript)),
      historyThrough: (target, signal) => this.runAction('history', 'Loading history…', operation => this.historyThrough(target, AbortSignal.any([signal, operation]))),
      removeQueued: itemId => this.runAction('command', 'Removing queued input…', () => this.removeQueued(itemId)),
      savePrompt: text => this.runImmediateAction(async () => {
        await this.promptStore.save(text); this.update({ lastFailure: '' });
      }),
      updatePrompt: (id, text) => this.runImmediateAction(async () => {
        if (!await this.promptStore.update(id, text)) throw new Error('That saved prompt no longer exists');
        this.update({ lastFailure: '' });
      }),
      deletePrompt: id => this.runImmediateAction(async () => {
        if (!await this.promptStore.remove(id)) throw new Error('That saved prompt no longer exists');
        this.update({ lastFailure: '' });
      }),
      command: (line, signal) => this.runActionValue('command', 'Running command…', () => this.command(line, signal)),
      exportLog: (path, signal) => this.runActionValue('export', 'Exporting session log…', () => this.exportLog(path, signal)),
      exportHtml: (path, signal) => this.runActionValue('export', 'Exporting conversation…', () => this.exportHtml(path, signal)),
      selectModel: (provider, model, effort) => this.runAction('model', 'Selecting model…', signal => this.catalog.selectModel(provider, model, effort, signal)),
      modelCatalog: () => this.runActionValue('model', 'Loading models…', signal => this.catalog.modelCatalog(signal)),
      refreshCosts: signal => this.runAction('cost', 'Refreshing costs…', operation => this.refreshCosts(signal === undefined ? operation : AbortSignal.any([signal, operation]))),
      loadPresetNames: () => this.loadPresetNames(),
      clearFailure: () => this.clearFailure(),
      enterPath: () => this.enterPath(),
      pickWorkspace: id => this.pickWorkspace(id),
      showChat: () => this.showChat(),
      showLatest: () => this.session.setViewWindow(undefined),
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
      get forkedVerification() { return controller.loops.forkedVerification; },
      get selfScoring() { return controller.loops.selfScoring; },
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
      get loop() { return controller.loops.progress; },
      get foreground() { return controller.foregroundSlot.snapshot; },
      get sources() { return controller.outputSources(); },
      get peek() { return controller.peekSnapshot(); },
      get activity() { return controller.activity; },
      get loopRecords() { return listLoopRecords(); },
      pendingCounts: () => controller.pendingCounts(),
      recall: (direction, current) => controller.recall(direction, current),
      references: (query, signal) => controller.references(query, signal),
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
    // Nobody waits forever for a slot that will never be handed out again.
    this.foregroundSlot.close();
    this.catalog.close();
    await this.loops.close();
    this.dropPeek();
    await this.shell.stop();
    await this.connection.stop();
    await this.session.settle();
    await this.catalog.settle();
    await this.cost?.stop();
    await this.memoryLog?.stop();
    await this.trace?.settle();
    this.session.release();
  }

  /** Stop the selected turn and then close, so quitting does not leave host work running.
   * An idle session stays untouched, and an in-flight cancellation is awaited rather than repeated.
   */
  async shutdown(): Promise<void> {
    if (this.session.active) await this.session.interrupt(true);
    await this.stop();
  }

  /** Run one mutating operation inside the client's single foreground slot.
   *
   * Private on purpose: the application owns the slot, so a caller never hands the controller a
   * closure to orchestrate. Every entry of `actions` uses it, and `actions.foreground` is the one
   * door left open for work the front end orchestrates itself.
   * @param kind - What the operation is, for the label and the trace.
   * @param label - Human label shown while it runs.
   * @param operation - Operation to run while the client is busy.
   * @returns Whether the operation ran to completion.
   */
  private async runAction(kind: ForegroundKind, label: string, operation: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    if (!this.state.online) { this.update({ lastFailure: 'Not connected. Try again after reconnecting.' }); return false; }
    return await this.foregroundSlot.run(kind, label, async signal => {
      try { await operation(signal); return true; }
      catch (error) { this.update({ lastFailure: errorText(error) }); return false; }
    }) === true;
  }

  /** Same slot, for an operation that produces a value the caller needs. */
  private async runActionValue<T>(kind: ForegroundKind, label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (!this.state.online) { this.update({ lastFailure: 'Not connected. Try again after reconnecting.' }); return undefined; }
    return await this.foregroundSlot.run(kind, label, async signal => {
      try { return await operation(signal); }
      catch (error) { this.update({ lastFailure: errorText(error) }); return undefined; }
    });
  }

  /** Run outside the foreground slot, with the same application failure reporting.
   * Local prompt edits need no connection; verifier cancellation uses the session control lane and
   * must reach the host even while the foreground is busy or closed for shutdown.
   */
  private async runImmediateAction(operation: () => Promise<void>): Promise<boolean> {
    try { await operation(); return true; }
    catch (error) { this.update({ lastFailure: errorText(error) }); return false; }
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
    this.traceEvent('generation', { phase: 'begin', screen: this.state.screen, session: this.state.sessionId ?? 'none' });
    this.session.beginGeneration();
    this.catalog.reset();
    this.connectionSettled = false;
    // A busy state does not survive the connection it was observed on.
    this.busySessions.clear();
    this.update({ controlError: undefined });
  }

  /** The event stream is ready and the control baseline is applied. */
  async ready(): Promise<void> {
    this.update({ online: true, status: 'Connected', pending: [], lastFailure: '' });
    this.catalog.refresh();
    const screen = this.state.screen;
    this.traceEvent('generation', { phase: 'ready', screen });
    this.traceEvent('navigation-refresh', { screen });
    await this.session.refreshLists();
    // Startup may choose the local workspace. Reconnect only refreshes data: it must not reinterpret
    // the reader's current screen as a request to navigate or discard a selected conversation.
    if (!this.initialized && this.state.screen === 'workspaces' && !this.state.sessionId && !this.initialSession) {
      const adopted = this.session.adoptLocalWorkspace(this.localDirectory);
      this.traceEvent('adopt', { directory: this.localDirectory, workspace: adopted ?? 'none' });
      if (adopted !== undefined) this.update({ status: 'Workspace from this directory · ← to switch' });
    }
    const selected = this.state.sessionId;
    const sessionId = selected ?? this.loops.sessionId ?? (!this.initialized ? this.initialSession : undefined);
    this.traceEvent('resolve', { session: sessionId ?? 'none', looping: this.loops.sessionId ?? 'none', reselect: sessionId !== undefined });
    if (selected !== undefined) this.session.restoreSelectedSession();
    else if (sessionId !== undefined) await this.session.selectSession(sessionId);
    this.initialized = true;
    // `online` means the socket works; `connectionSettled` means the picker and the selection are
    // done, which is what an automation caller must wait for or it races `showPicker`.
    this.connectionSettled = true;
    this.update({});
    this.traceEvent('generation', { phase: 'settled', screen: this.state.screen, session: this.state.sessionId ?? 'none' });
    this.cost?.start();
  }

  /** The generation ended; invalidate session work and stop the scan.
   *
   * A running loop is deliberately left alone: the host keeps running the review, and the client
   * re-selects the same session after reconnecting, so only a switch to another session ends it.
   */
  async ended(): Promise<void> {
    this.traceEvent('generation', { phase: 'ended', screen: this.state.screen, session: this.state.sessionId ?? 'none' });
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
          this.loops.idle(event.sessionId);
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
  private get sessionMode(): string | undefined { return this.session.sessionMode(this.state.presets); }

  /** @returns Epoch start of the active turn, when known. */
  private get workingSince(): number | undefined { return this.session.workingSince; }

  /** What the client is doing right now, merged across the host turn and any running loop.
   *
   * This is the controller's answer, not a view's guess: a turn speaks for the session while it runs,
   * otherwise a live loop speaks for itself with its own sub-state and clock, and neither means idle.
   * @returns The activity, or undefined when nothing is in flight.
   */
  private get activity(): ClientActivity | undefined {
    if (this.running) {
      return { kind: 'turn', ...(this.workingSince === undefined ? {} : { since: this.workingSince }) };
    }
    const progress = this.loops.progress;
    if (progress === undefined || !progress.active) return undefined;
    // A paused run is still the client's work, but nothing is running: the bar must ask for the reader
    // rather than claim a clock.
    if (progress.phase === 'needs-human') {
      return { kind: 'paused', title: progress.title, step: progress.step, total: progress.total };
    }
    if (progress.activity === undefined) return undefined;
    return { kind: 'loop', activity: progress.activity, title: progress.title,
      step: progress.step, total: progress.total, startedAt: progress.startedAt };
  }

  /** @returns Sessions accounted to the selected workspace, minus archived identities. */
  private get visibleSessions(): ObjectValue[] { return this.session.visibleSessions; }

  /** Every readable output source, newest activity first.
   *
   * Three origins feed one list, because a reader asking "what is that session" does not care which
   * layer knows about it: sessions this client created (the host cannot record that link), local `!`
   * runs it already holds, and host-created subagent children, whose only lineage is their list row.
   * A client-created source wins over the list row for the same session, since it says more.
   * @returns Sources to offer, running ones first.
   */
  private outputSources(): OutputSource[] {
    const sources: OutputSource[] = [];
    const seen = new Set<string>();
    for (const [id, source] of this.createdSources) { sources.push(source); seen.add(id); }
    for (const block of this.state.shell.blocks) {
      // A note runs nothing: it is a bar pointing at another source, which is listed on its own.
      if (block.kind !== 'shell') continue;
      const id = localSourceId(block.id);
      if (seen.has(id)) continue;
      seen.add(id);
      sources.push({
        id, kind: 'local', label: `! ${block.command}`,
        state: block.status === 'running' ? 'running' : 'ended',
        startedAt: block.startedAt,
        ...(block.endedAt === undefined ? {} : { endedAt: block.endedAt }),
        createdBy: 'shell',
        ...(this.state.sessionId === undefined ? {} : { parentSessionId: this.state.sessionId }),
      });
    }
    for (const row of this.visibleSessions) {
      const sessionId = string(row.sessionId);
      const parent = typeof row.parentSessionId === 'string' ? row.parentSessionId : '';
      if (sessionId === '' || parent === '' || row.origin !== 'subagent' || seen.has(sessionId)) continue;
      seen.add(sessionId);
      sources.push({
        id: sessionId, kind: 'session', label: sessionLabel(row), state: 'ended',
        ...(typeof row.updatedAt === 'number' ? { startedAt: row.updatedAt } : {}),
        createdBy: 'agent', parentSessionId: parent,
      });
    }
    return sources.sort((a, b) => a.state === b.state
      ? (b.startedAt ?? 0) - (a.startedAt ?? 0)
      : a.state === 'running' ? -1 : 1);
  }

  /** Register a session this client created for a verifier, so the list can explain it. */
  private async createVerifierSession(title: string): Promise<string | undefined> {
    const sessionId = await this.session.createNamedSession(title);
    if (sessionId === undefined) return undefined;
    const parent = this.state.sessionId;
    this.createdSources.set(sessionId, {
      id: sessionId, kind: 'session', label: verifierLabel(title), state: 'running', startedAt: Date.now(),
      createdBy: 'verifier',
      ...(parent === undefined ? {} : { parentSessionId: parent }),
      ...(this.loops.verifierName === undefined ? {} : { detail: `verifier ${this.loops.verifierName}` }),
    });
    // The bar the run echoed into the transcript now opens this session, which is the newest check.
    this.shell.link(sessionId);
    // A long-lived client runs many reviews; the registry is a convenience list, not a ledger, and a
    // dropped session is still reachable by selecting it. Insertion order is the age order.
    while (this.createdSources.size > SOURCE_LIMIT) {
      const oldest = this.createdSources.keys().next().value;
      if (oldest === undefined) break;
      this.createdSources.delete(oldest);
    }
    this.update({});
    return sessionId;
  }

  /** Mark a source this client created as finished, keeping it readable. */
  private endSource(id: string, at: number): void {
    const source = this.createdSources.get(id);
    if (source === undefined || source.state === 'ended') return;
    this.createdSources.set(id, { ...source, state: 'ended', endedAt: at });
    this.update({});
  }

  /** Open one source read-only at full screen; a session source starts following it. */
  private openPeek(id: string): void {
    const source = this.outputSources().find(candidate => candidate.id === id);
    if (source === undefined || this.peekId === id) return;
    this.peekId = id;
    this.traceEvent('peek begin', { source: id, kind: source.kind });
    if (source.kind === 'session') {
      const row = this.visibleSessions.find(candidate => string(candidate.sessionId) === id);
      // The list row is the only place that knows a child needs its parent in the address.
      this.peek.open(row === undefined ? [{ kind: 'session', sessionId: id }] : costAddresses(row), () => this.update({}));
    }
    this.update({});
  }

  /** Close the read-only view and release whatever it followed. */
  private closePeek(): void {
    if (this.peekId === undefined) return;
    this.traceEvent('peek end', { source: this.peekId });
    this.peek.close();
    this.peekId = undefined;
    this.update({});
  }

  /** Release the view without publishing; the caller is already inside an update. */
  private dropPeek(): void {
    if (this.peekId === undefined) return;
    this.traceEvent('peek end', { source: this.peekId });
    this.peek.close();
    this.peekId = undefined;
  }

  /** What the read-only view renders, or undefined while it is closed. */
  private peekSnapshot(): PeekSnapshot | undefined {
    if (this.peekId === undefined) return undefined;
    const source = this.outputSources().find(candidate => candidate.id === this.peekId);
    if (source === undefined) return undefined;
    if (source.kind === 'local') {
      const block = this.state.shell.blocks.find(candidate => `shell:${candidate.id}` === source.id);
      return { source, lines: block?.lines ?? [] };
    }
    const followed = this.peek.snapshot;
    if (followed === undefined) return { source };
    return { source, transcript: followed.transcript, ...(followed.error === undefined ? {} : { error: followed.error }) };
  }

  /** @returns Unanswered interactions by session, for the state each list row reports. */
  private pendingCounts(): ReadonlyMap<string, number> { return this.session.pendingCounts(); }

  /** Load the optional preset roster once per connection. */
  private loadPresetNames(): void { this.catalog.loadPresetNames(); }

  /** Stop the selected turn, or allow exit only while idle.
   * @param force - Send an explicit cancellation even when the cached running flag is idle.
   * @returns True when the caller may exit.
   */
  private interrupt(force = false): Promise<boolean> {
    // Esc and Ctrl+C stop the automated loop as well as the turn; otherwise it would keep sending.
    this.loops.stop();
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

  /** Clear the internal last failure; a no-op when there is none. */
  private clearFailure(): void {
    if (this.state.lastFailure !== '') this.update({ lastFailure: '' });
  }

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
  private async showPicker(screen: 'workspaces' | 'sessions', signal?: AbortSignal): Promise<void> {
    this.traceEvent('action', { action: 'showPicker', screen });
    await this.session.showPicker(screen, signal);
  }

  /** Resolve a removal command to one reviewable object.
   * @param kind - Workspace registration removal or session archival.
   * @param query - Exact name, ID, or unambiguous ID prefix.
   * @returns The fixed identity and display details for confirmation.
   */
  private async removalTarget(kind: 'workspace' | 'session', query: string): Promise<RemovalTarget> { return this.session.removalTarget(kind, query); }

  /** Apply a confirmed removal or verified empty-session archival.
   * @param target - Exact workspace or session identity reviewed by the user.
   */
  private async removeTarget(target: RemovalTarget): Promise<void> {
    this.traceEvent('action', { action: 'removeTarget', kind: target.kind, id: target.id });
    await this.session.removeTarget(target);
  }

  /** Pick a workspace, or use all sessions when the identity is omitted.
   * @param workspaceId - Workspace to select, if any.
   */
  private pickWorkspace(workspaceId?: string): void {
    this.traceEvent('action', { action: 'pickWorkspace', workspace: workspaceId ?? 'none' });
    this.session.pickWorkspace(workspaceId);
  }

  /** Leave a picker and return to the selected conversation, without reloading it.
   * @returns Whether there was a selected conversation to return to.
   */
  private showChat(): boolean {
    const shown = this.session.showChat();
    this.traceEvent('action', { action: 'showChat', shown });
    return shown;
  }

  /** Open a workspace picker, or resolve a workspace target.
   * @param query - Workspace target, if any.
   */
  private async switchWorkspace(query?: string, signal?: AbortSignal): Promise<void> {
    this.traceEvent('action', { action: 'switchWorkspace', query: query ?? 'picker' });
    await this.session.switchWorkspace(query, signal);
  }

  /** Guide session selection, list all sessions with `all`, or resolve a target.
   * @param query - Session target, `all`, or nothing for the guided picker.
   */
  private async switchSession(query?: string, signal?: AbortSignal): Promise<void> {
    this.traceEvent('action', { action: 'switchSession', query: query ?? 'picker' });
    await this.session.switchSession(query, signal);
  }

  /** Prompt for a host path without starting a local agent. */
  private enterPath(): void {
    this.traceEvent('action', { action: 'enterPath' });
    this.session.enterPath();
  }

  /** Register a host directory and move to its session picker.
   * @param path - Absolute directory path on the host.
   */
  private async createWorkspace(path: string, signal?: AbortSignal): Promise<void> {
    this.traceEvent('action', { action: 'createWorkspace', path });
    await this.session.createWorkspace(path, signal);
  }

  /** Create a session in the selected workspace. */
  private async createSession(signal?: AbortSignal): Promise<void> {
    this.traceEvent('action', { action: 'createSession', workspace: this.state.workspaceId ?? 'none' });
    await this.session.createSession(signal);
  }

  /** Replace the selected transcript and follow the session.
   * @param sessionId - Session to follow.
   */
  private async selectSession(sessionId: string): Promise<void> {
    this.traceEvent('action', { action: 'selectSession', session: sessionId });
    await this.session.selectSession(sessionId);
  }

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
    this.loops.stop();
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

  /** Cancel the active turn; pending queue items remain host-owned. */
  private async cancelTurn(): Promise<void> {
    this.loops.stop();
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

  /** Answer the current sub-question of the pending set, advancing the waterfall or sending it.
   *
   * The waterfall is interaction state of the session — which sub-question is current follows from the
   * answers collected so far, and the ticked labels live in the option state — so it belongs here
   * rather than in a front end. Both entry points then complete a question the same way: a line the
   * operator typed as an answer, and the option keys.
   * @param input - Labels chosen for this sub-question, or free text the operator typed.
   * @returns True once the answer was recorded or sent; a host refusal throws, leaving the collected
   *   answers in place so the same submission can be retried.
   */
  private async answerQuestion(input: { selected?: readonly string[]; custom?: string } = {}): Promise<boolean> {
    const pending = this.state.pending[0];
    if (pending?.kind !== 'question') throw new Error('No pending question');
    const interaction = this.state.session.interaction;
    const answers = interaction.answers[pending.eventId] ?? [];
    const question = pending.questions[answers.length];
    if (question === undefined) throw new Error('The pending question has changed');
    // A typed answer keeps whatever is ticked for a multi-select question; a picked option is explicit.
    const selected = input.selected ?? (question.multiSelect === true ? interaction.option?.selected ?? [] : []);
    const answer = { id: question.id, selected: [...selected], ...(input.custom ? { custom: input.custom } : {}) };
    const next = [...answers, answer];
    if (next.length < pending.questions.length) {
      this.setAnswers({ ...interaction.answers, [pending.eventId]: next });
      this.setOption(undefined);
      return true;
    }
    // A rejected submission keeps the collected answers and the keyboard state, so the reader can
    // retry the same answer instead of rebuilding it: a refusal throws out of here before the
    // collected answers are dropped.
    await this.answer({ answers: next });
    const rest = { ...interaction.answers };
    delete rest[pending.eventId];
    this.setAnswers(rest);
    this.setOption(undefined);
    return true;
  }

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
