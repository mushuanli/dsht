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
