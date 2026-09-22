/** Periodic billing scans; the ledger outlives any single connection generation. */
import type { Client } from '../transport/client.ts';
import { array, errorText, object, string, type Json, type ObjectValue } from '../transport/wire.ts';
import type { CostLedger } from './ledger.ts';
import { sessionCostHistory } from './scanner.ts';

/** Host access a scan needs; supplied by the controller facade. */
export interface CostHost {
  /** Connected client, or undefined while offline. */
  client(): Client | undefined;
  /** Whether the current connection generation is online. */
  online(): boolean;
  /** Client lifetime signal, aborted when the process closes the connection. */
  signal(): AbortSignal;
  /** Re-publish controller state after the ledger changes. */
  publish(): void;
  /** Hand one already-read history page to another consumer, which owns what it does with it. */
  scanPage?(sessionId: string, records: readonly Json[]): void;
  /** Report that a session's history was read to its beginning. */
  scanDone?(sessionId: string): void;
}

/** Refresh interval for the background cost scan. */
const REFRESH_INTERVAL_MS = 60_000;

/** Owns the background scan: startup, the minute timer, turn-completion refresh, and `/cost`. */
export class CostController {
  private task: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private updates = new Map<string, number>();
  constructor(readonly ledger: CostLedger, private readonly host: CostHost) {}

  /** Scan immediately, then once a minute while online.
   *
   * Every generation starts with no skip bookkeeping, because the host keeps running while this
   * client is not connected: an update time this client already recorded cannot prove that nothing
   * happened during the gap, so the first scan of the generation reads every session's history
   * again. Within that generation the recorded times keep the minute timer from re-reading idle
   * sessions.
   */
  start(): void {
    if (this.timer) return;
    this.updates.clear();
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => { if (this.host.online()) void this.refresh().catch(() => undefined); }, REFRESH_INTERVAL_MS);
  }

  /** Cancel the timer and active scan, then wait for cleanup; keep already folded totals. */
  async stop(): Promise<void> {
    clearInterval(this.timer); this.timer = undefined;
    this.abort?.abort();
    await this.task;
  }

  /** Refresh after the host reports a turn complete. */
  onTurnIdle(): void {
    if (this.host.online()) void this.refresh().catch(() => undefined);
  }

  /** Refresh all HTTP-visible sessions without changing the selected conversation.
   * @param signal - Optional cancellation for an explicit `/cost` refresh.
   */
  async refresh(signal: AbortSignal = this.host.signal()): Promise<void> {
    signal.throwIfAborted();
    this.host.signal().throwIfAborted();
    if (this.task) {
      const scanAbort = this.abort;
      const cancel = () => scanAbort?.abort();
      signal.addEventListener('abort', cancel, { once: true });
      try { await this.task; } finally { signal.removeEventListener('abort', cancel); }
      return;
    }
    const client = this.host.client();
    if (!client) throw new Error('Not connected');
    this.abort = new AbortController();
    const combined = AbortSignal.any([signal, this.host.signal(), this.abort.signal]);
    const ledger = this.ledger;
    ledger.scanning = true; ledger.error = '';
    const task = Promise.resolve().then(async () => {
      try {
        combined.throwIfAborted();
        const sessions = array(object(await client.call('session/list', { _request: {} }, combined)).items).map(object);
        combined.throwIfAborted();
        const failures: string[] = [];
        let scanned = 0, pages = 0, events = 0;
        for (const session of sessions) {
          combined.throwIfAborted();
          const sessionId = string(session.sessionId);
          if (!session.running && typeof session.updatedAt === 'number' && this.updates.get(sessionId) === session.updatedAt) continue;
          try {
            const history = await sessionCostHistory(client, session, combined, () => { pages++; },
              records => this.host.scanPage?.(sessionId, records));
            this.host.scanDone?.(sessionId);
            scanned++; events += history.events.length;
            await ledger.replace(sessionId, history.cursor, history.events);
            combined.throwIfAborted();
            if (!session.running && typeof session.updatedAt === 'number') this.updates.set(sessionId, session.updatedAt);
            this.host.publish();
          } catch (error) {
            // One unreachable or rejected session must not freeze every other session's rates.
            combined.throwIfAborted();
            failures.push(`${sessionId}: ${errorText(error)}`);
          }
        }
        ledger.error = failures.length === 0 ? '' : `${failures.length} of ${sessions.length} sessions failed: ${failures[0]}`;
        ledger.lastScan = { sessions: scanned, pages, events };
        ledger.scannedAt = Date.now();
      } catch (error) { ledger.error = errorText(error); }
      finally { ledger.scanning = false; this.host.publish(); }
    });
    this.task = task;
    // Publish only after reserving the scan: an observer may synchronously join or cancel it.
    this.host.publish();
    try { await task; } finally { this.task = undefined; this.abort = undefined; }
  }
}
