/** What the session domain reads from the connection the controller owns. */
import type { Telemetry } from './telemetry.ts';
import type { ObjectValue } from '../transport/wire.ts';

/** Read-only connection facts and actions the session controller needs. */
export interface ConnectionView {
  /** Projection store of the current generation. */
  telemetryView(): Telemetry;
  /** Cached host running flag for one session, or undefined when never reported. */
  runningFor(sessionId: string): boolean | undefined;
  /** When this client first observed the session, for the elapsed-time fallback. */
  observedAt(sessionId: string): number | undefined;
  /** Record an observation start for a session this client just opened. */
  observe(sessionId: string): void;
  /** Fail the current generation, so the controller reopens a snapshot. */
  fail(error: Error): void;
  /** Answer one retained host waterfall through the event-result endpoint. */
  reply(frame: ObjectValue, outcome: ObjectValue): Promise<void>;
}
