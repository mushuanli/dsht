/** Application state shared by the controller facade and every domain controller. */
import { SessionInfo } from './session/info.ts';
import type { HistorySearch, PendingInteraction, RemovalTarget } from './session/types.ts';
import type { ShellSnapshot } from './shell/index.ts';
import type { ObjectValue } from './transport/wire.ts';

/** Transient state of one mutually-exclusive application action.
 *
 * `error` is the single failure line the UI shows today. Connection and session failures still write
 * here while they have no per-feature error channel of their own; splitting them out is a later,
 * behaviour-changing step, so this field keeps the exact current display semantics.
 */
export interface OperationState { busy: boolean; error: string }

/** State shared by the picker and conversation view. */
export interface State {
  version: number;
  /** What the application itself is doing right now. */
  operation: OperationState;
  online: boolean;
  screen: 'workspaces' | 'sessions' | 'chat' | 'path';
  status: string;
  workspaces: ObjectValue[];
  sessions: ObjectValue[];
  showAllSessions: boolean;
  workspaceId?: string;
  sessionId?: string;
  pending: PendingInteraction[];
  controlError?: string;
  modelError?: string;
  presetError?: string;
  presets?: ObjectValue[];
  defaultModel?: ObjectValue;
  /** Local `!` runs, published so the UI never reads the shell service object. */
  shell: ShellSnapshot;
  /** Record, prompt index, composer, view and interaction state of the selected session. */
  session: SessionInfo;
}

/** The state contract every domain controller writes through. */
export interface ControllerStore {
  /** Current immutable state snapshot. */
  readonly state: State;
  /** Publish a state patch and notify observers. */
  update(patch: Partial<State>): void;
  /** Monotonic selector generation; a changed value discards in-flight session work. */
  selection(): number;
  /** Advance the selector generation when the selected workspace or session changes. */
  bumpSelection(): void;
}

/** Build the initial state before any connection exists.
 * @returns A fresh state whose transcript is empty and disconnected.
 */
export function initialState(): State {
  return { version: 0, operation: { busy: false, error: '' }, online: false, screen: 'workspaces',
    status: 'Connecting…', workspaces: [], sessions: [], showAllSessions: false, pending: [],
    shell: { running: false, blocks: [] }, session: new SessionInfo() };
}

export type { HistorySearch, RemovalTarget };
