/** CNY estimates folded from host history: per-session totals and per-day buckets, re-decided by every scan. */
import type { ObjectValue } from '../transport/wire.ts';
import { chargeFor, costDay, costMonthStart, costWeekStart, costWindowStart, DEFAULT_PRICES, pricesDigest, PRICING_ENGINE_VERSION } from './pricing.ts';
import { foldSamples } from './records.ts';
import { loadLedgers, pruneLedgers, saveLedger } from './ledger-files.ts';
import { MISSING_USAGE, type CostTotal, type Coverage, type DayTotal, type PriceVersion, type SavedCost } from './types.ts';

/** Reasons one slice keeps at most, so a broken table cannot grow the ledger without bound. */
const UNPRICED_LIMIT = 8;

/** Per-origin cache of folded session totals and day buckets; every scan replaces a session at its cut. */
export class CostLedger {
  private sessions = new Map<string, SavedCost>();
  /** New sessions are known to begin at zero, but have not yet had their history scanned. */
  private provisional = new Set<string>();
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
    return this.provisional.size === 0 && (this.scannedAt !== undefined || this.sessions.size > 0) ? 'complete' : 'partial';
  }

  /** Load the newest cut per session; a stored total is read as it was decided.
   *
   * Slices and dead files that have left the retention window are deleted in the same pass, so the
   * directory cannot grow with every session this client has ever seen. A slice is a projection of the
   * host log, so letting one go costs a rescan of that session, never data.
   * @param now - Clock that names the window, so a caller or a test can pin the boundary.
   */
  async load(now = Date.now()): Promise<void> {
    this.totals.clear();
    this.provisional.clear();
    this.sessions = await loadLedgers(this.directory);
    for (const sessionId of await pruneLedgers(this.directory, costWindowStart(now), this.sessions)) {
      this.sessions.delete(sessionId);
    }
  }

  /** Show zero immediately for a session this client just created, until a host scan confirms it.
   * The provisional slice is memory only; a later scan replaces it with the actual history.
   */
  seedNewSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, { version: 4, sessionId, cut: -2, engine: PRICING_ENGINE_VERSION,
      catalog: this.catalog, total: { amount: 0, unknown: 0, records: 0 }, days: [], unpriced: [] });
    this.provisional.add(sessionId);
    this.totals.clear();
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
    const scanDay = costDay(now);
    const floor = costWindowStart(now);
    const total: CostTotal = { amount: 0, unknown: 0, records: 0 };
    const days = new Map<string, DayTotal>();
    const unpriced = new Set<string>();
    /** The day bucket to add to, created on first use so a session reports only the days it touched. */
    const dayBucket = (day: string): DayTotal => {
      const found = days.get(day);
      if (found !== undefined) return found;
      const created: DayTotal = { day, amount: 0, unknown: 0, records: 0 };
      days.set(day, created);
      return created;
    };
    for (const sample of foldSamples(events)) {
      const decision = chargeFor(this.prices, sample.provider, sample.model, sample.time, sample.usage);
      // A request belongs to the day it settled on. One with no settlement time is attributed to the
      // day of this scan, which is the only day it can reach without guessing a tariff band, and is
      // where a reader looks for what makes today's total inexact.
      const day = sample.time === undefined ? scanDay : costDay(sample.time);
      // Only the window is stored, so a session a year old writes days, not a year of them.
      const buckets = day < floor ? [total] : [total, dayBucket(day)];
      for (const bucket of buckets) {
        bucket.records++;
        if (decision.amount === undefined) bucket.unknown++;
        else bucket.amount += decision.amount;
      }
      if (decision.amount === undefined && unpriced.size < UNPRICED_LIMIT) unpriced.add(`${sample.provider}/${sample.model}: ${decision.reason}`);
    }
    const saved: SavedCost = { version: 4, sessionId, cut, engine: PRICING_ENGINE_VERSION, catalog: this.catalog,
      total, days: [...days.values()].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0), unpriced: [...unpriced] };
    // Another process may have persisted a newer cut of this session since it was last read.
    if (this.directory && !await saveLedger(this.directory, saved)) return;
    this.sessions.set(sessionId, saved);
    this.provisional.delete(sessionId);
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
   * The day is a real bucket rather than only the day a scan ran on, so asking for another day
   * reports that day's spend; the retention window is what limits how far back the answer reaches.
   * @param now - Clock that names the day to report.
   * @returns The day's total across cached sessions.
   */
  today(now = Date.now()): CostTotal {
    const day = costDay(now);
    return this.period(day, day);
  }

  /** Every session's requests in the natural week containing a day, through that day.
   * @param now - Clock that names the day to report.
   * @returns The week-to-date total across cached sessions.
   */
  week(now = Date.now()): CostTotal {
    const day = costDay(now);
    return this.period(costWeekStart(day), day);
  }

  /** Every session's requests in the natural month containing a day, through that day.
   * @param now - Clock that names the day to report.
   * @returns The month-to-date total across cached sessions.
   */
  month(now = Date.now()): CostTotal {
    const day = costDay(now);
    return this.period(costMonthStart(day), day);
  }

  /** Sum stored day buckets over a Beijing day range, inclusive at both ends.
   *
   * Days outside the retention window are absent rather than zero, so a range wider than the window
   * reports what is still kept — which is why the fold and this sum share one window constant.
   * @param from - First day to include, YYYY-MM-DD.
   * @param to - Last day to include, YYYY-MM-DD.
   * @returns The range's total across cached sessions.
   */
  private period(from: string, to: string): CostTotal {
    const key = `p:${from}..${to}`;
    const cached = this.totals.get(key);
    if (cached) return cached;
    const result: CostTotal = { amount: 0, unknown: 0, records: 0 };
    for (const session of this.sessions.values()) {
      for (const day of session.days) {
        // ISO day strings compare chronologically, so a lexical range is the day range.
        if (day.day < from || day.day > to) continue;
        result.amount += day.amount; result.unknown += day.unknown; result.records += day.records;
      }
    }
    this.totals.set(key, result);
    return result;
  }
}

/** Compact estimates retain an asterisk whenever a subtotal is not exact.
 * @param total - Summary from the ledger.
 * @returns Yuan amount and incompleteness marker.
 */
