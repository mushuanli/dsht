/** Immutable CNY ledger: a charge is priced once and never follows later price configuration. */
import type { ObjectValue } from '../transport/wire.ts';
import { chargeFor, costDay, DEFAULT_PRICES } from './pricing.ts';
import { foldSamples } from './records.ts';
import { loadLedgers, saveLedger } from './ledger-files.ts';
import { MISSING_USAGE, type Charge, type ChargeSample, type CostTotal, type Coverage, type PriceVersion, type SavedCost } from './types.ts';

/** Attach the current decision for a sample, or keep the amount an earlier scan sealed.
 *
 * Only an amount is final: a request that was unpriced stays open, so a table that later covers its
 * model — or a corrected table — prices it without a reprice, and a request that had not reported
 * tokens yet is priced when it does. The recorded rates travel with the amount, so re-deciding an
 * unpriced request cannot move a sealed one.
 * @param prices - Price table loaded now.
 * @param sample - Sample folded from the host history.
 * @param previous - Decision an earlier scan recorded for the same sample, when there was one.
 * @returns The sealed amount, or a fresh decision.
 */
function decide(prices: PriceVersion[], sample: ChargeSample, previous: Charge | undefined): Charge {
  if (previous?.amount !== undefined) return previous;
  return { ...sample, ...chargeFor(prices, sample.provider, sample.model, sample.time, sample.usage) };
}

/** Per-origin cache of decided request charges; each scan replaces a session at a fixed cut. */
export class CostLedger {
  private sessions = new Map<string, SavedCost>();
  private totals = new Map<string, CostTotal>();
  scannedAt?: number;
  scanning = false;
  error = '';
  /** Ledger files kept but not read, so a panel can say that recorded amounts were left in place. */
  unreadableFiles = 0;
  /** Work the last completed scan performed, so a memory sample can attribute its allocation. */
  lastScan?: { sessions: number; pages: number; events: number };
  constructor(readonly prices: PriceVersion[] = DEFAULT_PRICES, readonly directory?: string,
    /** Whether the table came from a file the user maintains, rather than the shipped one. */
    readonly customPrices = false) {}

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
    const loaded = await loadLedgers(this.directory);
    this.unreadableFiles = loaded.unreadable;
    for (const [sessionId, saved] of loaded.sessions) {
      if ((this.sessions.get(sessionId)?.cut ?? -2) <= saved.cut) this.sessions.set(sessionId, saved);
    }
  }

  /** Decide every stored charge again with the table loaded now.
   *
   * A stored charge keeps the sample it was decided from, so it can be decided again without the
   * host's history. This is the repair for a table that was wrong when the decisions were sealed,
   * and the way a corrected table reaches amounts that were already recorded. Charges without usage
   * keep their record, because their request never reported tokens to decide from.
   * @returns How many charges now carry a different amount or price identity.
   */
  async reprice(): Promise<number> {
    let changed = 0;
    for (const [sessionId, saved] of [...this.sessions]) {
      let touched = false;
      const charges = saved.charges.map(charge => {
        if (charge.usage === undefined) return charge;
        const decided: Charge = { ...charge, ...chargeFor(this.prices, charge.provider, charge.model, charge.time, charge.usage) };
        if (decided.amount === charge.amount && decided.priceId === charge.priceId) return charge;
        changed++; touched = true;
        return decided;
      });
      if (!touched) continue;
      const next: SavedCost = { ...saved, charges };
      if (this.directory) await saveLedger(this.directory, next);
      this.sessions.set(sessionId, next);
    }
    if (changed > 0) this.totals.clear();
    return changed;
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
   *
   * Every amount is attributed to the Beijing calendar day of its settlement time, so a dated range
   * adds exactly the records it contains and the day subtotals always add up to the lifetime total.
   * @param sessionId - Optional session restriction.
   * @param days - Today or today plus the preceding two calendar days.
   * @param now - Clock used for date attribution.
   * @returns Known subtotal, unpriceable count, and how many requests the range covers.
   */
  total(sessionId?: string, days?: 1 | 3, now = Date.now()): CostTotal {
    const cacheKey = JSON.stringify([sessionId, days, days ? costDay(now) : '']);
    const cached = this.totals.get(cacheKey);
    if (cached) return cached;
    const result: CostTotal = { amount: 0, unknown: 0, records: 0 };
    const end = costDay(now); const start = costDay(now - ((days ?? 1) - 1) * 86400_000);
    for (const session of this.sessions.values()) {
      if (sessionId !== undefined && session.sessionId !== sessionId) continue;
      for (const charge of session.charges) {
        if (days && charge.time !== undefined && (costDay(charge.time) < start || costDay(charge.time) > end)) continue;
        result.records++;
        if (charge.amount === undefined) { result.unknown++; continue; }
        if (days === undefined || charge.time !== undefined) result.amount += charge.amount;
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
export function costText(total: CostTotal): string { return `~¥${total.amount.toFixed(4)}${total.unknown ? '*' : ''}`; }
