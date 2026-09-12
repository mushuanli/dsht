/** CNY estimates folded from host history: per-session totals, re-decided by every scan. */
import type { ObjectValue } from '../transport/wire.ts';
import { chargeFor, costDay, DEFAULT_PRICES, pricesDigest, PRICING_ENGINE_VERSION } from './pricing.ts';
import { foldSamples } from './records.ts';
import { loadLedgers, saveLedger } from './ledger-files.ts';
import { MISSING_USAGE, type CostTotal, type Coverage, type DayTotal, type PriceVersion, type SavedCost } from './types.ts';

/** Reasons one slice keeps at most, so a broken table cannot grow the ledger without bound. */
const UNPRICED_LIMIT = 8;

/** Per-origin cache of folded session totals; every scan replaces a session at its cut. */
export class CostLedger {
  private sessions = new Map<string, SavedCost>();
  private totals = new Map<string, CostTotal>();
  private readonly catalog: string;
  scannedAt?: number;
  scanning = false;
  error = '';
  /** Work the last completed scan performed, so a memory sample can attribute its allocation. */
  lastScan?: { sessions: number; pages: number; events: number };
  constructor(readonly prices: PriceVersion[] = DEFAULT_PRICES, readonly directory?: string,
    /** Whether the table came from a file the user maintains, rather than the shipped one. */
    readonly customPrices = false) {
    this.catalog = pricesDigest(prices);
  }

  /** Cached totals count as complete; only a failed scan or an empty ledger is partial.
   * @returns Coverage of the current totals, so callers can mark them without re-deriving the rule.
   */
  get coverage(): Coverage {
    if (this.scanning) return 'scanning';
    if (this.error) return 'partial';
    return this.scannedAt !== undefined || this.sessions.size > 0 ? 'complete' : 'partial';
  }

  /** Load the newest cut per session; a stored total is read as it was decided. */
  async load(): Promise<void> {
    this.totals.clear();
    this.sessions = await loadLedgers(this.directory);
  }

  /** Replace one session using all billing events through the opening snapshot cut.
   *
   * The fold is the projection: every sample is decided again with the table loaded now, so a
   * corrected table reaches history on the next scan and a request no table covered yet is priced
   * as soon as one does. Only the totals are kept, and the cut and engine keep an older scan from
   * replacing a newer one.
   * @param sessionId - Host session identity.
   * @param cut - Opening cursor, preventing a stale scan from overwriting a newer scan.
   * @param events - Minimal events returned by `costRecords`, across all history pages.
   * @param now - Clock that names the calendar day the day bucket covers.
   */
  async replace(sessionId: string, cut: number, events: ObjectValue[], now = Date.now()): Promise<void> {
    const current = this.sessions.get(sessionId);
    if ((current?.cut ?? -2) > cut) return;
    const day = costDay(now);
    const total: CostTotal = { amount: 0, unknown: 0, records: 0 };
    const today: DayTotal = { day, amount: 0, unknown: 0, records: 0 };
    const unpriced = new Set<string>();
    for (const sample of foldSamples(events)) {
      const decision = chargeFor(this.prices, sample.provider, sample.model, sample.time, sample.usage);
      // A request belongs to the day it settled on, so the day bucket only counts the requests of
      // the calendar day this scan is running on; another day reads as nothing spent today. A request
      // with no settlement time belongs to no day, so it is counted as unknown wherever it is read.
      const buckets = sample.time === undefined || costDay(sample.time) === day ? [total, today] : [total];
      for (const bucket of buckets) {
        bucket.records++;
        if (decision.amount === undefined) bucket.unknown++;
        else bucket.amount += decision.amount;
      }
      if (decision.amount === undefined && unpriced.size < UNPRICED_LIMIT) unpriced.add(`${sample.provider}/${sample.model}: ${decision.reason}`);
    }
    const saved: SavedCost = { version: 3, sessionId, cut, engine: PRICING_ENGINE_VERSION, catalog: this.catalog,
      total, day: today, unpriced: [...unpriced] };
    // Another process may have persisted a newer cut of this session since it was last read.
    if (this.directory && !await saveLedger(this.directory, saved)) return;
    this.sessions.set(sessionId, saved);
    this.totals.clear();
  }

  /** Count the retained ledger so a memory sample can separate it from the transcript window.
   * @returns Sessions, requests and unpriced requests currently held.
   */
  summary(): { sessions: number; records: number; unpriced: number } {
    let records = 0, unpriced = 0;
    for (const session of this.sessions.values()) { records += session.total.records; unpriced += session.total.unknown; }
    return { sessions: this.sessions.size, records, unpriced };
  }

  /** Whether this session has a complete cached scan.
   * @param sessionId - Selected session identity, which may be unset before one is picked.
   * @returns True when a complete scan is available, narrowing the identity to a string.
   */
  hasSession(sessionId: string | undefined): sessionId is string { return sessionId !== undefined && this.sessions.has(sessionId); }

  /** Describe unpriced model/usage combinations without exposing conversation content.
   * @returns Unique reasons across cached sessions.
   */
  missing(): string[] { return [...new Set([...this.sessions.values()].flatMap(s => s.unpriced))]; }

  /** One session's stored totals.
   * @param sessionId - Session identity to report.
   * @returns The total a scan folded for it, or zeros when no scan has covered it.
   */
  total(sessionId: string): CostTotal {
    const cached = this.totals.get(`s:${sessionId}`);
    if (cached) return cached;
    const session = this.sessions.get(sessionId);
    const result: CostTotal = session === undefined ? { amount: 0, unknown: 0, records: 0 } : { ...session.total };
    this.totals.set(`s:${sessionId}`, result);
    return result;
  }

  /** Every session's requests on one Beijing calendar day.
   *
   * A slice keeps only the day its last scan ran on, so another day reads as nothing spent today
   * rather than as the last day that was scanned.
   * @param now - Clock that names the day to report.
   * @returns The day's total across cached sessions.
   */
  today(now = Date.now()): CostTotal {
    const day = costDay(now);
    const cached = this.totals.get(`d:${day}`);
    if (cached) return cached;
    const result: CostTotal = { amount: 0, unknown: 0, records: 0 };
    for (const session of this.sessions.values()) {
      if (session.day.day !== day) continue;
      result.amount += session.day.amount; result.unknown += session.day.unknown; result.records += session.day.records;
    }
    this.totals.set(`d:${day}`, result);
    return result;
  }
}

/** Compact estimates retain an asterisk whenever a subtotal is not exact.
 * @param total - Summary from the ledger.
 * @returns Yuan amount and incompleteness marker.
 */
export function costText(total: CostTotal): string { return `~¥${total.amount.toFixed(4)}${total.unknown ? '*' : ''}`; }
