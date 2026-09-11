/** Cost-domain types shared by pricing, record folding, storage and the in-memory ledger. */

/** Per-million-token rates for one peak or off-peak bucket. */
export interface Rates { input: number; cacheRead: number; cacheWrite: number; output: number }

/** An explicit validity interval and weekday peak windows in the named time zone. */
export interface PriceVersion {
  id: string; provider: string; model: string; from: string; until?: string;
  currency: 'CNY'; source: string; timezone: string;
  peak: Rates; offPeak: Rates; weekdays: number[]; windows: [number, number][];
}

/** Disjoint token buckets reported for one model request. */
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

/** One folded request sample before a price decision is attached. */
export interface ChargeSample { key: string; time?: number; provider: string; model: string; usage?: Usage }

/** The price decision recorded the first time a request sample was evaluated. */
export interface PriceDecision { priceId?: string; amount?: number; estimated?: true; reason?: string }

/** One ledger entry: a request sample plus the price decision that seals it. */
export interface Charge extends ChargeSample, PriceDecision {}

/** One session's persisted ledger slice. */
export interface SavedCost { version: 2; sessionId: string; cut: number; charges: Charge[] }

/** Summary retains the known subtotal, the records it could not price, and the coarse estimates.
 * `unknown` counts records with no amount at all; `estimated` counts records that only have a
 * floor amount, including dated requests whose timestamp cannot place them inside the range.
 */
export interface CostTotal { amount: number; unknown: number; estimated: number; records: number }

/** How much of the visible history the cached ledger currently covers. */
export type Coverage = 'complete' | 'scanning' | 'partial';

/** Reason recorded when a sample carries no usable token counts. */
export const MISSING_USAGE = 'missing usage';
