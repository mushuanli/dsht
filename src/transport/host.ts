/** Host access contract every domain controller uses for the active connection generation. */
import type { Client } from './client.ts';

/** One authenticated host connection, as seen by a domain that never owns it. */
export interface HostAccess {
  /** Connected client, or undefined while offline or between generations. */
  client(): Client | undefined;
  /** Connected client, or a `Not connected` failure. */
  require(): Client;
  /** Whether the current generation has applied its host baseline. */
  online(): boolean;
  /** Client lifetime signal, aborted when the process closes the connection. */
  signal(): AbortSignal;
}
