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

/** One folded request sample before a price decision is attached. */
export interface ChargeSample { key: string; time?: number; provider: string; model: string; usage?: Usage }

/** The price decision recorded the first time a request sample was priced.
 *
 * `matchedBy`, `engine` and `catalog` are recorded with every amount so a charge can be traced to
 * the rules and the rates that produced it: `matchedBy` says whether the model matched the table
 * exactly or through a declared alias, `engine` names the decision rules, and `catalog` digests the
 * price version itself, which an edited file can change while keeping its id.
 */
export interface PriceDecision {
  priceId?: string; amount?: number; reason?: string;
  matchedBy?: 'exact' | 'alias'; engine?: number; catalog?: string;
}

/** One ledger entry: a request sample plus the price decision that seals it. */
export interface Charge extends ChargeSample, PriceDecision {}

/** One session's persisted ledger slice. */
export interface SavedCost { version: 2; sessionId: string; cut: number; charges: Charge[] }

/** Summary retains the known subtotal and the records it could not price.
 * `unknown` counts records with no amount; `records` counts every request the range covers, so a
 * subtotal is never read as complete without them.
 */
export interface CostTotal { amount: number; unknown: number; records: number }

/** How much of the visible history the cached ledger currently covers. */
export type Coverage = 'complete' | 'scanning' | 'partial';

/** Reason recorded when a sample carries no usable token counts. */
export const MISSING_USAGE = 'missing usage';
/** Reason recorded when the host reported a cache-write bucket the published table does not price. */
export const UNSUPPORTED_USAGE = 'unsupported usage';
/** Reason recorded when the request has no settlement time to place it in a peak band or a day. */
export const MISSING_TIME = 'missing time';
