/** State and publication capabilities owned by the session domain. */
import type { NavigationState } from './navigator.ts';
import type { SessionInfo } from './info.ts';
import type { PendingInteraction } from './types.ts';

export interface SessionState extends NavigationState {
  online: boolean;
  status: string;
  lastFailure: string;
  pending: PendingInteraction[];
  session: SessionInfo;
}

/** The connection and application derive online/pending; session actions cannot overwrite them. */
export type SessionUpdate = Partial<Omit<SessionState, 'online' | 'pending' | 'session'>>;

export interface SessionStore {
  readonly state: Readonly<SessionState>;
  update(patch: SessionUpdate): void;
  selection(): number;
  bumpSelection(): void;
  busy(): boolean;
}
