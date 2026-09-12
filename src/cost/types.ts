/** Cost-domain types shared by pricing, record folding, storage and the in-memory ledger. */

/** Per-million-token rates for one peak or off-peak bucket. */
export interface Rates { input: number; cacheRead: number; cacheWrite: number; output: number }

/** An explicit validity interval and weekday peak windows in the named time zone. */
export interface PriceVersion {
  id: string; provider: string; model: string;
  /** Further model names this version prices; a trailing `*` matches a prefix. Never a guess. */
  aliases?: string[];
  from: string; until?: string;
  currency: 'CNY'; source: string; timezone: string;
  peak: Rates; offPeak: Rates; weekdays: number[]; windows: [number, number][];
}

/** Disjoint token buckets reported for one model request. */
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

/** One folded request sample: the attempt identity and the facts a price decision needs. */
export interface ChargeSample { key: string; time?: number; provider: string; model: string; usage?: Usage }

/** What the table decides for one request sample: an amount, or the reason it has none. */
export interface PriceDecision { amount?: number; reason?: string }

/** Summary retains the known subtotal and the records it could not price.
 * `unknown` counts records with no amount; `records` counts every request the range covers, so a
 * subtotal is never read as complete without them.
 */
export interface CostTotal { amount: number; unknown: number; records: number }

/** One Beijing calendar day's requests, kept only for the day a scan ran on. */
export interface DayTotal extends CostTotal { day: string }

/** One session's persisted ledger slice.
 *
 * The host log and the loaded price table are the only inputs, so the slice stores the totals one
 * scan folded them into and no per-request detail: the next scan reads the session's history again
 * and decides every sample with the table loaded then. `engine` and `catalog` name the decision
 * rules and the table behind these totals, so a process holding an older one cannot overwrite them.
 */
export interface SavedCost {
  version: 3;
  sessionId: string;
  /** Durable sequence the fold reached; a scan that opened an older cut may not replace this slice. */
  cut: number;
  engine: number;
  catalog: string;
  total: CostTotal;
  day: DayTotal;
  /** Distinct reasons an amount is missing, bounded, so a panel can say what makes a total inexact. */
  unpriced: string[];
}

/** How much of the visible history the cached ledger currently covers. */
export type Coverage = 'complete' | 'scanning' | 'partial';

/** Reason recorded when a sample carries no usable token counts. */
export const MISSING_USAGE = 'missing usage';
/** Reason recorded when the host reported a cache-write bucket the published table does not price. */
export const UNSUPPORTED_USAGE = 'unsupported usage';
/** Reason recorded when the request has no settlement time to place it in a peak band or a day. */
export const MISSING_TIME = 'missing time';
