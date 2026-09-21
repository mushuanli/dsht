/** The plain contract the UI reads: types and nothing else.
 *
 * Leaf components import their props from here instead of reaching into a feature, so the boundary
 * between presentation and the domain stays a type-only dependency. Anything this file needs at
 * runtime belongs in a view model next to the component that renders it.
 */
export type { Json, ObjectValue } from './json.ts';
export type { HistoryRow, Reasoning, RowKind, SessionRender } from './session/history.ts';
export type { LivePhase, Message } from './session/transcript.ts';
export type { FileReference } from './references.ts';
export type { HistorySearch, RemovalTarget } from './session/types.ts';
export type { QueuedInput } from './session/telemetry.ts';
export type { ModelState, PanelState } from './session/info.ts';
export type { CostTotal, Coverage } from './cost/index.ts';
export type { ShellBlock } from './shell/index.ts';

import type { ModelState, PanelState } from './session/info.ts';
import type { RemovalTarget } from './session/types.ts';

/** One user-saved shortcut prompt; the client owns the list, no session or host does. */
export interface SavedPrompt { id: string; text: string }

/** One panel-like surface the reader can see; the application names it, the UI renders it. */
export type PanelName = 'help' | 'cost' | 'status' | 'queue' | 'prompts'
  | 'thoughts' | 'history' | 'search' | 'model' | 'removal' | 'loop';

/** One `loop.yaml` record as the record list offers it.
 *
 * The name is what `/loop` runs; the rest is what a chooser shows about it, plus the defaults a run
 * started from this record would use. The application reads them from the same records the runner
 * does, so the list can never advertise a default the run would not apply.
 */
export interface LoopRecord {
  /** Record key in `loop.yaml`, the name `/loop` takes. */
  name: string;
  /** Rendered label of the record, e.g. `Design review` or `Designdoc review · tui-design.md`. */
  title: string;
  /** Rounds the record defines, which a full run ends on. */
  steps: number;
  /** Workspace file the rounds maintain, when the record declares one. */
  artifact?: string;
  /** Passing score used when nothing overrides it. */
  defaultScore: number;
  /** Attempts per round used when nothing overrides it. */
  defaultTries: number;
  /** Fixed inputs the record's templates use, with the values a run starts from.
   *
   * The form offers one editable row per name, so a record whose inputs are part of the task (the
   * document under review, a target, a threshold) is retargeted without editing `loop.yaml`.
   */
  vars: Readonly<Record<string, string>>;
}

/** The four numbers one loop run uses.
 *
 * The parameter form edits them and `resolveLoop` settles them from the record's defaults, so both
 * sides of `/loop` speak one shape. Declared here because a UI leaf may read the contract but not the
 * application that runs the loop.
 */
export interface LoopLimits {
  from: number;
  to: number;
  score: number;
  tries: number;
}

/** What one operator-driven foreground operation is doing.
 *
 * The kind is diagnostic and presentational: the front end shows the label, and the trace records what
 * the client was busy with. It never decides policy — that is the command's own declared policy (§3.4).
 */
export type ForegroundKind =
  | 'navigation'
  | 'picker'
  | 'removal'
  | 'prompt'
  | 'interaction'
  | 'history'
  | 'search'
  | 'command'
  | 'export'
  | 'model'
  | 'cost'
  | 'loop'
  | 'verifier'
  | 'handoff'
  | 'local';

/** The one operation that owns the client right now, as a view renders it.
 *
 * There is at most one: the slot serializes what the operator is doing, which is a different question
 * from the session write order (§6.3) — a read takes this slot too. The controller owns the slot, its
 * abort controller and its identity, so "what is running, and how do I cancel it" has one answer.
 */
export interface ForegroundSnapshot {
  /** Monotonic identity, so a view can tell two operations apart. */
  readonly id: number;
  readonly kind: ForegroundKind;
  /** Label the front end shows while it runs. */
  readonly label: string;
  /** Epoch the operation started, for a clock and for the trace. */
  readonly startedAt: number;
}

/** What one still-running loop is waiting on.
 *
 * The controller decides this; a view only renders it. `turn` and `verify` are the two ways a round
 * is judged (the reviewed session's own turn, or a forked verifier), and `settle` is the gap between
 * a finished turn and the attempt being consumed, when the result block may still be arriving.
 */
export type LoopActivity = 'turn' | 'verify' | 'settle';

/** What the client is working on right now.
 *
 * The controller merges the host turn and any running loop into this one answer, so a status bar
 * never has to decide what "busy" means or where its clock starts.
 */
export type ClientActivity =
  | { kind: 'turn'; since?: number }
  | { kind: 'loop'; activity: LoopActivity; title: string; step: number; total: number; startedAt: number }
  /** A run that stopped to ask the operator something: nothing is working, so there is no clock. */
  | { kind: 'paused'; title: string; step: number; total: number };

/** Why one loop run reached a terminal phase.
 *
 * Recorded once, when the run stops; it answers "who or what ended it" without overloading `phase`
 * (which already says what the outcome was). A cancelled run and a verifier that needs a person are
 * different facts and must not share a field.
 */
export type LoopTerminalReason =
  | 'user-cancelled'
  | 'turn-cancelled'
  | 'send-rejected'
  | 'verifier-needs-human'
  | 'verifier-unavailable'
  | 'deadline'
  | 'pass'
  | 'exhausted'
  | 'stalled'
  | 'blocked'
  | 'replaced';

/** Progress of a client-driven agent loop, as the UI reads it.
 *
 * One snapshot serves every protocol (`/loop <name>` and its records): the application
 * owns the loop, the UI only renders this line.
 */
export interface LoopProgress {
  /** Identity of this run; stable across reconnect, session and generation changes. */
  runId: string;
  /** Protocol label, such as `Design review`. */
  title: string;
  /** Epoch when this run started, so the status bar can clock it like a turn while it works. */
  startedAt: number;
  /** First and last step of the run. */
  from: number;
  to: number;
  /** Steps the protocol defines, so `from`/`to` can be told apart from the whole record. */
  total: number;
  /** Which rounds this run covers, e.g. `rounds 1–10/10` or `rounds 1–3/10 · selected range`. */
  scope: string;
  /** Passing score per step and the attempt budget per step. */
  score: number;
  tries: number;
  /** Step and attempt in flight, both 1-based. */
  step: number;
  attempt: number;
  /** What this step is about, when the protocol names its steps. */
  stepLabel?: string;
  /** Best score seen in the current step. */
  best: number;
  /** One line about how the last attempt was decided, when there is something to say. */
  note?: string;
  /** What the run is waiting on while it is still running; absent once it has stopped.
   *
   * `phase` says whether the run lives and how it ended; this says what the live run is doing, which
   * is the part a status bar needs and the part a view cannot infer from a free-text note.
   */
  activity?: LoopActivity;
  /** Whether the run is still going.
   *
   * This is the **only** predicate concurrency and authorization may read: a snapshot can outlive the
   * run (the terminal progress line stays visible), so "the snapshot exists" never means "it runs".
   */
  active: boolean;
  /** Why the run stopped, once it has; absent while it is still running. */
  terminalReason?: LoopTerminalReason;
  /** `running` while the loop runs; `blocked` means the verifier proved the task impossible, and
   *  `stalled` that another attempt would only repeat the previous verdict. */
  /** `unavailable` means the verifier could not judge, so no attempt was spent on a score. */
  /** `needs-human` means the verifier stopped on a host approval or question it cannot answer. */
  phase: 'running' | 'passed' | 'exhausted' | 'stalled' | 'blocked' | 'unavailable' | 'cancelled' | 'needs-human' | 'deadline';
  /** What the host is waiting for, when the loop stopped on `needs-human`. */
  interaction?: { kind: string; text: string; needs?: string };
  /** Why the verifier proved the task impossible, when the loop ended as `blocked`. */
  exit?: { reason: string };
}

/** One presentational verb the application asks a front end to carry out.
 *
 * The application decides which effects a command produces; the UI only interprets these verbs, so it
 * never learns which command ran or what it means. Adding a command therefore needs no UI change
 * unless it needs a genuinely new verb here. A discriminated union rather than optional fields: the
 * payload-carrying verbs (`history`, `search`, `model`, `removal`, `loop`) keep their own shape, and
 * an illegal combination cannot be written down.
 *
 * The front end applies them **in array order** — that order is the contract, not a suggestion, and
 * `applyEffects` never re-sorts. The application emits them as:
 *
 * `closePanels → close → open/toggle → live/pinLive/resetFolds/toggle* → scroll/scrollBy → notice/error`
 */
export type ViewEffect =
  /** Transient line shown above the composer. */
  | { kind: 'notice'; text: string }
  /** Failure line the operator can read; applied last so it survives the other effects. */
  | { kind: 'error'; text: string }
  /** Close every panel except the one opened or toggled in this same result. */
  | { kind: 'closePanels' }
  /** Open one panel with no payload; its rows come from the record or queries. */
  | { kind: 'open'; panel: PanelName }
  /** Toggle one of the read-only panels (`help`, `cost`, `status`). */
  | { kind: 'toggle'; panel: PanelName }
  /** Close one panel. */
  | { kind: 'close'; panel: PanelName }
  /** Payload that opens its own panel. */
  | { kind: 'history'; history: PanelState['history'] }
  | { kind: 'search'; search: PanelState['search'] }
  | { kind: 'model'; model: ModelState }
  | { kind: 'removal'; removal: RemovalTarget }
  /** Open the loop parameter form for one record, so its defaults are confirmed before the run. */
  | { kind: 'loop'; loop: { name: string } }
  /** Release a detached history window and return to the live end. */
  | { kind: 'live' }
  /** Drop the reading protection that keeps history pinned. */
  | { kind: 'pinLive' }
  /** Drop every reasoning fold. */
  | { kind: 'resetFolds' }
  /** Toggle one folded reasoning block, jumping to it when it opens. */
  | { kind: 'toggleFold'; seq: number }
  /** Toggle the live reasoning fold between one row and full. */
  | { kind: 'toggleLiveReasoning' }
  /** Absolute scroll position. */
  | { kind: 'scroll'; position: number }
  /** Scroll relative to the current position. */
  | { kind: 'scrollBy'; delta: number }
  /** Enter copy mode. */
  | { kind: 'copy' }
  /** Exit the client. */
  | { kind: 'quit' };

/** Whether one submitted line was used up or left in the composer. */
export type CommandDisposition = 'consume' | 'retain';

/** How one submitted line ended.
 *
 * Orthogonal to `disposition`, which is why they are two fields and not one boolean: a syntax error is
 * `retain + rejected`, a success is `consume + ok`, a form that failed its own validation is
 * `retain + rejected`, and an export the operator aborted with Esc is `retain + cancelled`.
 */
export type CommandOutcome = 'ok' | 'rejected' | 'cancelled' | 'failed';

/** What one submitted line did, and what the front end must show.
 *
 * `undefined` instead of a result means the application did not accept the line at all — offline, a
 * line already in flight, or an action that declined to start — and the draft stays put.
 */
export interface CommandResult {
  /** Whether the composer should clear the line that produced this result. */
  disposition: CommandDisposition;
  /** The one fact about how it ended, shared by the notice the reader sees and the trace. */
  outcome: CommandOutcome;
  /** Presentational verbs, in the order the front end must apply them. */
  effects: ViewEffect[];
}
