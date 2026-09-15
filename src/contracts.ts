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
  | 'thoughts' | 'history' | 'search' | 'model' | 'removal';

/** Progress of the client-driven `/design-review` run, as the UI reads it.
 *
 * The application owns the loop; the UI only renders this snapshot.
 */
export interface DesignReviewProgress {
  /** First and last round of the run. */
  from: number;
  to: number;
  /** Per-round passing score and the attempt budget per round. */
  score: number;
  tries: number;
  /** Round and attempt in flight, both 1-based. */
  round: number;
  attempt: number;
  /** Best score seen in the current round. */
  best: number;
  /** `reviewing` while the loop runs; the other values are terminal. */
  phase: 'reviewing' | 'passed' | 'exhausted' | 'cancelled';
}

/** The presentational outcome of one submitted line.
 *
 * The application decides which intent a command produces; the UI only interprets these
 * presentational verbs, so it never learns which command ran or what it means. Adding a command
 * therefore needs no UI change unless it needs a genuinely new verb here.
 */
export interface CommandIntent {
  /** Transient line shown above the composer. */
  notice?: string;
  /** Failure line; the composer keeps its draft. */
  error?: string;
  /** Close every panel except the one this intent opens or toggles. */
  closePanels?: boolean;
  /** Open one panel with no payload; its rows come from the record or queries. */
  open?: PanelName;
  /** Toggle one of the read-only panels (`help`, `cost`, `status`). */
  toggle?: PanelName;
  /** Close one panel. */
  close?: PanelName;
  /** Payload that opens its own panel. */
  history?: PanelState['history'];
  search?: PanelState['search'];
  model?: ModelState;
  removal?: RemovalTarget;
  /** Release a detached history window and return to the live end. */
  live?: boolean;
  /** Drop the reading protection that keeps history pinned. */
  pinLive?: boolean;
  /** Drop every reasoning fold. */
  resetFolds?: boolean;
  /** Toggle one folded reasoning block, jumping to it when it opens. */
  toggleFold?: number;
  /** Toggle the live reasoning fold between one row and full. */
  toggleLiveReasoning?: boolean;
  /** Absolute scroll position applied after the effect. */
  scroll?: number;
  /** Scroll relative to the current position, applied after the effect. */
  scrollBy?: number;
  /** Enter copy mode. */
  copy?: boolean;
  /** Exit the client. */
  quit?: boolean;
  /** Free text that answers the pending question. */
  answer?: string;
}
