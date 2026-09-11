/** Application state shared by the controller facade and every domain controller. */
import { Transcript } from './session/transcript.ts';
import type { HistorySearch, RemovalTarget } from './session/types.ts';
import type { ObjectValue } from './transport/wire.ts';

/** State shared by the picker and conversation view. */
export interface State {
  version: number;
  online: boolean;
  busy: boolean;
  screen: 'workspaces' | 'sessions' | 'chat' | 'path';
  status: string;
  error: string;
  workspaces: ObjectValue[];
  sessions: ObjectValue[];
  showAllSessions: boolean;
  workspaceId?: string;
  sessionId?: string;
  pending: ObjectValue[];
  controlError?: string;
  modelError?: string;
  presetError?: string;
  presets?: ObjectValue[];
  defaultModel?: ObjectValue;
  transcript: Transcript;
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
  return { version: 0, online: false, busy: false, screen: 'workspaces', status: 'Connecting…',
    error: '', workspaces: [], sessions: [], showAllSessions: false, pending: [], transcript: new Transcript() };
}

export type { HistorySearch, RemovalTarget };
