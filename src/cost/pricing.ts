/** Versioned CNY price tables and the price decision taken for one request sample. */
import { createHash } from 'node:crypto';
import { object } from '../transport/wire.ts';
import { MISSING_TIME, MISSING_USAGE, UNSUPPORTED_USAGE, type PriceDecision, type PriceVersion, type Rates, type Usage } from './types.ts';

const clocks = new Map<string, Intl.DateTimeFormat>();

/** Published rates verified on 2026-09-12; preceding dates require historical configuration.
 * Flash and Pro are priced independently, and a separate cache write uses the cache-miss input rate.
 */
const OFFICIAL_PRICING = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const PEAK_SCHEDULE = { weekdays: [1, 2, 3, 4, 5], windows: [[540, 720], [840, 1080]] as [number, number][] };
const FLASH_RATES = { peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 },
  offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 } };
const PRO_RATES = { peak: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 },
  offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 } };
export const DEFAULT_PRICES: PriceVersion[] = [
  // The published table states that superseded Flash names stay callable and are served by
  // V4.1-Flash at Flash rates, so every name the host can report is listed instead of guessed at.
  { id: 'deepseek-2026-09-10-flash', provider: 'deepseek-official', model: 'deepseek-flash',
    aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-flash*', 'deepseek-v4.1-flash*', 'deepseek-v4.1-flash'],
    from: '2026-09-10T00:00:00+08:00', currency: 'CNY', source: OFFICIAL_PRICING, timezone: 'Asia/Shanghai',
    ...PEAK_SCHEDULE, ...FLASH_RATES },
  // The published table keeps V4 Pro available after 2026-09-14 at these rates, so the interval
  // stays open until a later page names an end.
  { id: 'deepseek-2026-09-10-pro', provider: 'deepseek-official', model: 'deepseek-v4-pro',
    // No `deepseek-pro*`: a prefix that broad would also claim `deepseek-proxy-*` or `deepseek-prompt-*`.
    aliases: ['deepseek-v4-pro', 'deepseek-v4-pro*', 'deepseek-v4.1-pro*'],
    from: '2026-09-10T00:00:00+08:00', currency: 'CNY', source: OFFICIAL_PRICING, timezone: 'Asia/Shanghai',
    ...PEAK_SCHEDULE, ...PRO_RATES },
];

/** Revision of the pricing decision rules, recorded with every amount they decided.
 *
 * Bump it whenever the rules change what an amount would be — the matching of a model name, the
 * token buckets an amount covers, or the timestamp it is priced at — so a recorded amount can be
 * traced to the rules that produced it. Version 1 matched a model by the substring `pro` and
 * priced a request with no settlement time at the cheapest off-peak rate.
 */
export const PRICING_ENGINE_VERSION = 2;

/** Revision of the shipped table, recorded beside a seeded file so a correction can replace it. */
export const PRICES_REVISION = '2026-09-12';

/** Rates the first published revision charged, rebuilt with the same arithmetic so the values compare equal.
 * It only recognizes that seed; it never prices a request.
 */
const UNCORRECTED_SEED_RATES: Record<string, { peak: Rates; offPeak: Rates }> = Object.fromEntries(
  ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'].map(model => {
    const scale = model === 'deepseek-v4-pro' ? 3 : 1;
    return [`deepseek-2026-09-10-${model}`, {
      peak: { input: 3 * scale, cacheRead: 0.1 * scale, cacheWrite: 3 * scale, output: 9 * scale },
      offPeak: { input: 1.5 * scale, cacheRead: 0.05 * scale, cacheWrite: 1.5 * scale, output: 4.5 * scale },
    }];
  }));

/** Whether a table is the seed an earlier revision wrote, which a corrected ship must replace.
 *
 * `prices.json` overrides the shipped table, so an install seeded before the Flash rates were
 * corrected keeps charging 1.5x for input and 2.5x for cache reads for as long as that file lives.
 * Only an exact match to the superseded revision qualifies, so a rate the user chose is never rewritten.
 * @param prices - Table loaded from the configuration file.
 * @returns True when every entry carries the superseded revision's rates.
 */
export function isUncorrectedSeed(prices: readonly PriceVersion[]): boolean {
  const superseded = Object.keys(UNCORRECTED_SEED_RATES);
  return prices.length === superseded.length && prices.every(price => {
    const legacy = UNCORRECTED_SEED_RATES[price.id];
    return legacy !== undefined && sameRates(price.peak, legacy.peak) && sameRates(price.offPeak, legacy.offPeak);
  });
}

/** Compare two rate sets, allowing the representation error a JSON round trip can introduce.
 * @param a - One rate set.
 * @param b - The other rate set.
 * @returns True when every rate agrees.
 */
function sameRates(a: Rates, b: Rates): boolean {
  return (['input', 'cacheRead', 'cacheWrite', 'output'] as const).every(bucket => Math.abs(a[bucket] - b[bucket]) < 1e-9);
}

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
    if (p.aliases !== undefined && (!Array.isArray(p.aliases) || p.aliases.some(alias => typeof alias !== 'string' || alias === ''))) throw new Error('Invalid price aliases');
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

/** Canonical form of a model name before matching.
 *
 * The host reports names that differ from the published table by width, case, surrounding space, or
 * the CJK full stop a display path can substitute for a period. Normalizing here keeps the table
 * readable and keeps a name variant from silently missing its entry. NFKC does not fold the CJK
 * stops, so they are mapped explicitly.
 * @param model - Model name exactly as the recorded request reported it.
 * @returns The name in the form the table is matched against.
 */
export function canonicalModel(model: string): string {
  return model.normalize('NFKC').replace(/[\u3002\uff0e\uff61]/g, '.').trim().toLowerCase();
}

/** Whether an alias matches a canonical model name, treating a trailing `*` as a prefix.
 * @param alias - Alias declared by a price version.
 * @param model - Canonical model name.
 * @returns True when the alias covers the name.
 */
function aliasMatches(alias: string, model: string): boolean {
  const canonical = canonicalModel(alias);
  return canonical.endsWith('*') ? model.startsWith(canonical.slice(0, -1)) : model === canonical;
}

/** Candidate versions for one request, in the order the table is searched: the exact model, then
 * the aliases a version declares. A name the table does not cover stays unpriced rather than
 * falling back to a family guess, because guessing a rate is indistinguishable from a wrong one.
 * @param prices - Validated versions.
 * @param provider - Provider identity from the recorded request.
 * @param model - Recorded model name.
 * @returns Matching versions, each with the rule that matched it.
 */
export function candidates(prices: PriceVersion[], provider: string, model: string): { price: PriceVersion; matchedBy: 'exact' | 'alias' }[] {
  const canonical = canonicalModel(model);
  const exact = prices.filter(p => p.provider === provider && canonicalModel(p.model) === canonical);
  if (exact.length) return exact.map(price => ({ price, matchedBy: 'exact' as const }));
  return prices.filter(p => p.provider === provider && (p.aliases ?? []).some(alias => aliasMatches(alias, canonical)))
    .map(price => ({ price, matchedBy: 'alias' as const }));
}

/** Stable identity of the rates that decided one charge.
 *
 * The identity a price version carries can be edited in place while keeping its `id` — which is how
 * a corrected table once kept charging superseded rates under one id — so the decision records a
 * digest of the version itself, not only its name.
 * @param price - Price version an amount was decided from.
 * @returns Short digest of that version.
 */
export function catalogDigest(price: PriceVersion): string {
  return createHash('sha256').update(JSON.stringify(price)).digest('hex').slice(0, 12);
}

/** Select a price by event time, applying half-open local peak windows.
 * @param prices - Validated versions.
 * @param provider - Provider identity from the recorded request.
 * @param model - Recorded model name.
 * @param time - Recorded settlement timestamp used as the billing instant.
 * @returns Matching price version, the rule that matched it, and its per-million-token rates.
 */
export function priceAt(prices: PriceVersion[], provider: string, model: string, time: number): { price: PriceVersion; rates: Rates; matchedBy: 'exact' | 'alias' } | undefined {
  const candidate = candidates(prices, provider, model)
    .find(({ price }) => Date.parse(price.from) <= time && (price.until === undefined || time < Date.parse(price.until)));
  if (candidate === undefined) return;
  const { price, matchedBy } = candidate;
  let clock = clocks.get(price.timezone);
  if (!clock) { clock = new Intl.DateTimeFormat('en-US', { timeZone: price.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); clocks.set(price.timezone, clock); }
  const parts = clock.formatToParts(time);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
  const minute = Number(part('hour')) * 60 + Number(part('minute'));
  return { price, matchedBy, rates: price.weekdays.includes(day) && price.windows.some(([a, b]) => minute >= a && minute < b) ? price.peak : price.offPeak };
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
  // The published DeepSeek table prices cache hits, cache misses and output; a fourth bucket means
  // the usage mapping is wrong, and inventing a rate for it would hide that.
  if (provider === 'deepseek-official' && usage.cacheWrite !== 0) return { reason: UNSUPPORTED_USAGE };
  // No settlement time means the host did not say when the request was billed, and the two peak
  // bands differ by a factor of two: a floor amount would enter the lifetime total while staying
  // out of every day range, so the charge is reported unresolved instead of guessed.
  if (time === undefined) return { reason: MISSING_TIME };
  const selected = priceAt(prices, provider, model, time);
  if (!selected) return { reason: 'no price version' };
  const amount = (usage.input * selected.rates.input + usage.output * selected.rates.output
    + usage.cacheRead * selected.rates.cacheRead + usage.cacheWrite * selected.rates.cacheWrite) / 1e6;
  if (!Number.isFinite(amount)) return { reason: 'invalid estimate' };
  return { priceId: selected.price.id, amount, matchedBy: selected.matchedBy,
    engine: PRICING_ENGINE_VERSION, catalog: catalogDigest(selected.price) };
}
