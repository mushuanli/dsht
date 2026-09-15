/** Per-session host runtime mirrors that are not connection state.
 *
 * `running` and the observation start change while the network stays perfectly healthy
 * (`ready → running → waiting → running`), so they belong to the session runtime rather than to the
 * connection. Both maps are keyed by `sessionId` and cleared at each connection generation.
 */
import type { ControlFrame } from '../transport/events.ts';
import { Telemetry } from './telemetry.ts';

/** Projection capabilities this client consumes; the host retains every other key. */
const RETAINED_PROJECTIONS = new Set(['title', 'modelSelection', 'contextPressure', 'tokenUsage', 'sessionStats', 'agentPreset']);

export class SessionRuntime {
  /** Host projection values for every session of the current generation. */
  telemetry = new Telemetry(RETAINED_PROJECTIONS);

  private readonly running = new Map<string, boolean>();
  private readonly observed = new Map<string, number>();

  /** Cached host running flag for one session, or undefined when never reported. */
  runningFor(sessionId: string): boolean | undefined { return this.running.get(sessionId); }

  /** When this client first observed the session running, for the elapsed-time fallback. */
  observedAt(sessionId: string): number | undefined { return this.observed.get(sessionId); }

  /** Remember when a session this client just opened was first seen. */
  observe(sessionId: string): void { if (!this.observed.has(sessionId)) this.observed.set(sessionId, Date.now()); }

  /** Apply one host running-state notification for a session. */
  accept(sessionId: string, running: boolean): void {
    if (running && !this.running.get(sessionId)) this.observed.set(sessionId, Date.now());
    if (!running) this.observed.delete(sessionId);
    this.running.set(sessionId, running);
  }

  /** Apply one normalized projection/queue/job frame. */
  acceptControl(frame: ControlFrame): void { this.telemetry.accept(frame); }

  /** Drop every generation-scoped mirror, including the projection store. */
  reset(): void { this.running.clear(); this.observed.clear(); this.telemetry = new Telemetry(RETAINED_PROJECTIONS); }
}
