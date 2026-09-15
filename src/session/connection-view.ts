/** What the session domain reads from the connection the controller owns. */
import type { Json } from '../transport/wire.ts';

/** Read-only connection facts and actions the session controller needs. */
export interface ConnectionView {
  /** Fail the current generation, so the controller reopens a snapshot. */
  fail(error: Error): void;
  /** Answer one retained host waterfall through the event-result endpoint. */
  reply(eventId: string, outcome: Json): Promise<void>;
}
