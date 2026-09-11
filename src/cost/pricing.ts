/** Versioned CNY price tables and the price decision taken for one request sample. */
import { object } from '../transport/wire.ts';
import { MISSING_USAGE, type PriceDecision, type PriceVersion, type Rates, type Usage } from './types.ts';

const clocks = new Map<string, Intl.DateTimeFormat>();

/** Published rates verified on 2026-09-10; preceding dates require historical configuration.
 * Flash and Pro are priced independently, and a separate cache write uses the cache-miss input rate.
 */
const OFFICIAL_PRICING = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const PEAK_SCHEDULE = { weekdays: [1, 2, 3, 4, 5], windows: [[540, 720], [840, 1080]] as [number, number][] };
const FLASH_RATES = { peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 },
  offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 } };
const PRO_RATES = { peak: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 },
  offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 } };
export const DEFAULT_PRICES: PriceVersion[] = [
  { id: 'deepseek-2026-09-10-flash', provider: 'deepseek-official', model: 'deepseek-flash',
    from: '2026-09-10T00:00:00+08:00', currency: 'CNY', source: OFFICIAL_PRICING, timezone: 'Asia/Shanghai',
    ...PEAK_SCHEDULE, ...FLASH_RATES },
  { id: 'deepseek-2026-09-10-pro', provider: 'deepseek-official', model: 'deepseek-v4-pro',
    from: '2026-09-10T00:00:00+08:00', until: '2026-09-14T12:00:00+08:00', currency: 'CNY',
    source: OFFICIAL_PRICING, timezone: 'Asia/Shanghai', ...PEAK_SCHEDULE, ...PRO_RATES },
  // The provider bills `deepseek-v4-pro` requests at Flash rates once V4 Pro is retired.
  { id: 'deepseek-2026-09-14-pro-served-by-flash', provider: 'deepseek-official', model: 'deepseek-v4-pro',
    from: '2026-09-14T12:00:00+08:00', currency: 'CNY', source: OFFICIAL_PRICING, timezone: 'Asia/Shanghai',
    ...PEAK_SCHEDULE, ...FLASH_RATES },
];

/** Validate user-maintained price versions, rejecting ambiguous overlapping intervals.
 * @param value - Parsed prices.json array.
 * @returns Price versions with validated rates and schedules.
 */
export function pricesFrom(value: unknown): PriceVersion[] {
  if (!Array.isArray(value)) throw new Error('prices.json must contain an array');
  const ids = new Set<string>();
  for (const raw of value) {
    const p = object(raw);
    for (const key of ['id', 'provider', 'model', 'source', 'timezone', 'from']) if (typeof p[key] !== 'string' || !p[key]) throw new Error(`Invalid price ${key}`);
    if (ids.has(String(p.id))) throw new Error('Duplicate price id'); ids.add(String(p.id));
    const from = Date.parse(String(p.from)); const until = p.until === undefined ? Infinity : Date.parse(String(p.until));
    if (!Number.isFinite(from) || !(until > from) || p.currency !== 'CNY') throw new Error('Invalid price interval or currency');
    new Intl.DateTimeFormat('en', { timeZone: String(p.timezone) }).format();
    for (const key of ['peak', 'offPeak']) for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output']) {
      const rate = object(p[key])[bucket];
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) throw new Error('Invalid token rate');
    }
    if (!Array.isArray(p.weekdays) || p.weekdays.some(d => typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6)
      || !Array.isArray(p.windows) || p.windows.some(w => !Array.isArray(w) || w.length !== 2 || w.some(n => typeof n !== 'number' || !Number.isInteger(n)) || Number(w[0]) < 0 || Number(w[1]) > 1440 || Number(w[0]) >= Number(w[1]))) throw new Error('Invalid peak schedule');
  }
  const prices = value as PriceVersion[];
  for (const [index, p] of prices.entries()) for (const q of prices.slice(index + 1)) {
    if (p.provider === q.provider && p.model === q.model && Date.parse(p.from) < (q.until ? Date.parse(q.until) : Infinity)
      && Date.parse(q.from) < (p.until ? Date.parse(p.until) : Infinity)) throw new Error('Overlapping price intervals');
  }
  return prices;
}

/** Return the calendar date used by both daily and three-calendar-day summaries.
 * @param time - Epoch milliseconds.
 * @returns Beijing calendar date, YYYY-MM-DD.
 */
export function costDay(time: number): string { return new Date(time + 8 * 3600_000).toISOString().slice(0, 10); }

/** Price family used when a recorded model name has no exact entry. */
function priceFamily(model: string): string { return model.toLowerCase().includes('pro') ? 'deepseek-v4-pro' : 'deepseek-flash'; }

/** Candidate versions for one request: its exact model first, then the official model family. */
function candidates(prices: PriceVersion[], provider: string, model: string): PriceVersion[] {
  const exact = prices.filter(p => p.provider === provider && p.model === model);
  if (exact.length) return exact;
  return provider === 'deepseek-official' ? prices.filter(p => p.model === priceFamily(model)) : [];
}

/** Select a price by event time, applying half-open local peak windows.
 * @param prices - Validated versions.
 * @param provider - Provider identity from the recorded request.
 * @param model - Recorded model name; official DeepSeek aliases fall back to Pro when containing pro, otherwise Flash.
 * @param time - Recorded settlement timestamp used as a billing-time estimate.
 * @returns Matching price version and per-million-token rates, if known.
 */
export function priceAt(prices: PriceVersion[], provider: string, model: string, time: number): { price: PriceVersion; rates: Rates } | undefined {
  const price = candidates(prices, provider, model).find(p => Date.parse(p.from) <= time && (p.until === undefined || time < Date.parse(p.until)));
  if (!price) return;
  let clock = clocks.get(price.timezone);
  if (!clock) { clock = new Intl.DateTimeFormat('en-US', { timeZone: price.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); clocks.set(price.timezone, clock); }
  const parts = clock.formatToParts(time);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
  const minute = Number(part('hour')) * 60 + Number(part('minute'));
  return { price, rates: price.weekdays.includes(day) && price.windows.some(([a, b]) => minute >= a && minute < b) ? price.peak : price.offPeak };
}

/** Select a rate without a settlement time, so an unattributable request still enters the total.
 * The cheapest candidate off-peak rate is a floor: it never overstates, and the charge stays
 * marked as estimated.
 * @param prices - Validated versions.
 * @param provider - Provider identity from the recorded request.
 * @param model - Recorded model name.
 * @returns The candidate version with the lowest off-peak input rate and its rates, if any.
 */
export function lowestPrice(prices: PriceVersion[], provider: string, model: string): { price: PriceVersion; rates: Rates } | undefined {
  let best: { price: PriceVersion; rates: Rates } | undefined;
  for (const price of candidates(prices, provider, model)) {
    if (best === undefined || price.offPeak.input < best.rates.input) best = { price, rates: price.offPeak };
  }
  return best;
}

/** Decide the amount for one request sample using the table loaded at decision time.
 *
 * The returned decision is recorded once and never revisited: a later `prices.json` change must
 * not move a historical amount. Only a sample with no usable usage (`missing usage`) is left
 * undecided, because its request has not finished reporting tokens yet.
 * @param prices - Validated versions currently loaded.
 * @param provider - Provider identity from the recorded request.
 * @param model - Recorded model name.
 * @param time - Recorded settlement timestamp, when the host logged one.
 * @param usage - Disjoint token buckets, when the host reported valid counts.
 * @returns The selected price identity, the amount, and the reason when no amount exists.
 */
export function chargeFor(prices: PriceVersion[], provider: string, model: string, time: number | undefined, usage: Usage | undefined): PriceDecision {
  if (!usage) return { reason: MISSING_USAGE };
  const selected = time === undefined ? lowestPrice(prices, provider, model) : priceAt(prices, provider, model, time);
  if (!selected) return { reason: 'no price version' };
  const amount = (usage.input * selected.rates.input + usage.output * selected.rates.output
    + usage.cacheRead * selected.rates.cacheRead + usage.cacheWrite * selected.rates.cacheWrite) / 1e6;
  if (!Number.isFinite(amount)) return { reason: 'invalid estimate' };
  return { priceId: selected.price.id, amount, ...(time === undefined ? { estimated: true as const } : {}) };
}
