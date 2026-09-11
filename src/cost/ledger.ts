/** Immutable CNY ledger: a charge is priced once and never follows later price configuration. */
import type { ObjectValue } from '../transport/wire.ts';
import { chargeFor, costDay, DEFAULT_PRICES } from './pricing.ts';
import { foldSamples } from './records.ts';
import { loadLedgers, saveLedger } from './ledger-files.ts';
import { MISSING_USAGE, type Charge, type ChargeSample, type CostTotal, type Coverage, type PriceVersion, type SavedCost } from './types.ts';

/** Whether a charge already carries a decision that a later scan must keep. */
function sealed(charge: Charge): boolean {
  return charge.amount !== undefined || (charge.reason !== undefined && charge.reason !== MISSING_USAGE);
}

/** Attach the current table's decision, or reuse the decision an earlier scan recorded.
 *
 * A sample without usage has not finished reporting tokens, so it stays open for the next scan;
 * every other decision — priced, unpriced, or estimated — is final.
 */
function decide(prices: PriceVersion[], sample: ChargeSample, previous: Charge | undefined): Charge {
  if (previous !== undefined && (sealed(previous) || sample.usage === undefined)) return previous;
  return { ...sample, ...chargeFor(prices, sample.provider, sample.model, sample.time, sample.usage) };
}

/** Per-origin cache of decided request charges; each scan replaces a session at a fixed cut. */
export class CostLedger {
  private sessions = new Map<string, SavedCost>();
  private totals = new Map<string, CostTotal>();
  scannedAt?: number;
  scanning = false;
  error = '';
  /** Work the last completed scan performed, so a memory sample can attribute its allocation. */
  lastScan?: { sessions: number; pages: number; events: number };
  constructor(readonly prices: PriceVersion[] = DEFAULT_PRICES, readonly directory?: string) {}

  /** Cached charges count as complete; only a failed scan or an empty ledger is partial.
   * @returns Coverage of the current totals, so callers can mark them without re-deriving the rule.
   */
  get coverage(): Coverage {
    if (this.scanning) return 'scanning';
    if (this.error) return 'partial';
    return this.scannedAt !== undefined || this.sessions.size > 0 ? 'complete' : 'partial';
  }

  /** Load the newest complete cut per session; recorded amounts load without re-pricing. */
  async load(): Promise<void> {
    this.totals.clear();
    for (const [sessionId, saved] of await loadLedgers(this.directory)) {
      if ((this.sessions.get(sessionId)?.cut ?? -2) <= saved.cut) this.sessions.set(sessionId, saved);
    }
  }

  /** Replace one session using all billing events through the opening snapshot cut.
   *
   * Sampling is replayed, but a charge that an earlier scan already decided keeps its recorded
   * `priceId` and `amount`, so editing `prices.json` only affects requests decided afterwards.
   * @param sessionId - Host session identity.
   * @param cut - Opening cursor, preventing a stale scan from overwriting a newer scan.
   * @param events - Minimal events returned by `costRecords`, across all history pages.
   */
  async replace(sessionId: string, cut: number, events: ObjectValue[]): Promise<void> {
    const current = this.sessions.get(sessionId);
    if ((current?.cut ?? -2) > cut) return;
    const previous = new Map<string, Charge>((current?.charges ?? []).map(charge => [charge.key, charge]));
    const charges = foldSamples(events).map(sample => decide(this.prices, sample, previous.get(sample.key)));
    const saved: SavedCost = { version: 2, sessionId, cut, charges };
    // Another process may have persisted a newer cut of this session since it was last read.
    if (this.directory && !await saveLedger(this.directory, saved)) return;
    this.sessions.set(sessionId, saved);
    this.totals.clear();
  }

  /** Count the retained ledger so a memory sample can separate it from the transcript window.
   * @returns Sessions and charges currently held, and how many charges carry no amount.
   */
  summary(): { sessions: number; charges: number; unpriced: number } {
    let charges = 0, unpriced = 0;
    for (const session of this.sessions.values()) {
      charges += session.charges.length;
      unpriced += session.charges.filter(charge => charge.amount === undefined).length;
    }
    return { sessions: this.sessions.size, charges, unpriced };
  }

  /** Whether this session has a complete cached scan.
   * @param sessionId - Selected session identity.
   * @returns True when a complete scan is available.
   */
  hasSession(sessionId?: string): boolean { return sessionId !== undefined && this.sessions.has(sessionId); }

  /** Describe unpriced model/usage combinations without exposing conversation content.
   * @returns Unique reasons across cached sessions.
   */
  missing(): string[] {
    return [...new Set([...this.sessions.values()].flatMap(s => s.charges.filter(c => c.amount === undefined).map(c => `${c.provider}/${c.model}: ${c.reason}`)))];
  }

  /** Summarize recorded requests across one session or Beijing calendar days.
   * @param sessionId - Optional session restriction.
   * @param days - Today or today plus the preceding two calendar days.
   * @param now - Clock used for date attribution.
   * @returns Known subtotal, unpriceable count, and estimated count; an estimated record always
   *   names an amount, but a dated range only adds the records it can place inside that range.
   */
  total(sessionId?: string, days?: 1 | 3, now = Date.now()): CostTotal {
    const cacheKey = JSON.stringify([sessionId, days, days ? costDay(now) : '']);
    const cached = this.totals.get(cacheKey);
    if (cached) return cached;
    const result: CostTotal = { amount: 0, unknown: 0, estimated: 0, records: 0 };
    const end = costDay(now); const start = costDay(now - ((days ?? 1) - 1) * 86400_000);
    for (const session of this.sessions.values()) {
      if (sessionId !== undefined && session.sessionId !== sessionId) continue;
      for (const charge of session.charges) {
        if (days && charge.time !== undefined && (costDay(charge.time) < start || costDay(charge.time) > end)) continue;
        result.records++;
        if (charge.amount === undefined) { result.unknown++; continue; }
        const dated = days === undefined || charge.time !== undefined;
        if (charge.estimated === true || !dated) result.estimated++;
        if (dated) result.amount += charge.amount;
      }
    }
    this.totals.set(cacheKey, result);
    return result;
  }
}

/** Compact estimates retain an asterisk whenever a subtotal is not exact.
 * @param total - Summary from the ledger.
 * @returns Yuan amount and incompleteness marker.
 */
export function costText(total: CostTotal): string { return `~¥${total.amount.toFixed(4)}${total.unknown || total.estimated ? '*' : ''}`; }
