/** Application composition of session state and the other domains' published snapshots. */
import { SessionInfo } from './session/info.ts';
import type { HistorySearch, RemovalTarget } from './session/types.ts';
import type { SessionState } from './session/state.ts';
import type { ShellSnapshot } from './shell/index.ts';
import type { ObjectValue } from './transport/wire.ts';

/** State shared by the picker and conversation view. */
export interface State extends SessionState {
  version: number;
  /** The last failure the application recorded, for a diagnostic line and a refusal's reason.
   *
   * Internal on purpose (13.2-D2): a command's failure fact is its `CommandResult.outcome` plus the
   * trace, and this is only what a connection, a session stream or an action envelope left behind.
   * Whether an operation is running is not stored here — that is `queries.foreground`.
   */
  lastFailure: string;
  controlError?: string;
  modelError?: string;
  presetError?: string;
  presets?: ObjectValue[];
  defaultModel?: ObjectValue;
  /** Local `!` runs, published so the UI never reads the shell service object. */
  shell: ShellSnapshot;
}

/** Application state access used by connection orchestration. Feature domains use their own ports. */
export interface ControllerStore {
  /** Current application snapshot; nested session data remains owned by the session domain. */
  readonly state: State;
  /** Publish a state patch and notify observers. */
  update(patch: Partial<State>): void;
  /** Monotonic selector generation; a changed value discards in-flight session work. */
  selection(): number;
  /** Advance the selector generation when the selected workspace or session changes. */
  bumpSelection(): void;
  /** Whether an operation owns the client's foreground slot right now. */
  busy(): boolean;
}

/** Build the initial state before any connection exists.
 * @returns A fresh state whose transcript is empty and disconnected.
 */
export function initialState(): State {
  return { version: 0, lastFailure: '', online: false, screen: 'workspaces',
    status: 'Connecting…', workspaces: [], sessions: [], showAllSessions: false, pending: [],
    shell: { running: false, blocks: [] }, session: new SessionInfo() };
}

export type { HistorySearch, RemovalTarget };
