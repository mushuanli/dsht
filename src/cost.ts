/** Versioned CNY estimates from durable request usage; provider invoices remain authoritative. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { object, array, type ObjectValue } from './wire.ts';

const clocks = new Map<string, Intl.DateTimeFormat>();

interface Rates { input: number; cacheRead: number; cacheWrite: number; output: number }
/** An explicit validity interval and weekday peak windows in the named time zone. */
export interface PriceVersion {
  id: string; provider: string; model: string; from: string; until?: string;
  currency: 'CNY'; source: string; timezone: string;
  peak: Rates; offPeak: Rates; weekdays: number[]; windows: [number, number][];
}
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

interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Charge { key: string; time?: number; provider: string; model: string; usage?: Usage; price?: PriceVersion; amount?: number; estimated?: true; reason?: string }
interface Saved { version: 1; sessionId: string; cut: number; charges: Charge[] }
/** Summary retains the known subtotal, the records it could not price, and the coarse estimates.
 * `unknown` counts records with no amount at all; `estimated` counts records that only have a
 * floor amount, including dated requests whose timestamp cannot place them inside the range.
 */
export interface CostTotal { amount: number; unknown: number; estimated: number; records: number }

/** How much of the visible history the cached ledger currently covers. */
export type Coverage = 'complete' | 'scanning' | 'partial';

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

/** Keep only billing-relevant fields; prompts, tool bodies, cookies and keys never enter the ledger.
 * @param records - One HTTP history page's records.
 * @returns Minimal durable events for a deterministic usage fold.
 */
export function costRecords(records: unknown): ObjectValue[] {
  return array(records).map(raw => object(object(raw).event)).filter(e => ['request/context', 'assistant/message', 'assistant/attempt', 'llm/retry-started', 'session/end-seed'].includes(String(e.type))).map(e => {
    const d = object(e.data); const m = object(d.message ?? {});
    const stream = array(d.stream ?? []).map(r => object(object(r).chunk ?? {})).filter(c => c.type === 'usage');
    return { seq: e.seq ?? null, time: e.time ?? null, type: e.type!, data: {
      inherited: d.inherited ?? false, turn: d.turn ?? null, step: d.step ?? null, provider: d.provider ?? null, model: d.model ?? null,
      source: m.source ?? null, usage: d.usage ?? stream.at(-1)?.usage ?? null,
    } };
  });
}

/** Per-origin cache of priced request settlements; each scan replaces a session at a fixed cut. */
export class CostLedger {
  private sessions = new Map<string, Saved>();
  private totals = new Map<string, CostTotal>();
  scannedAt?: number;
  scanning = false;
  error = '';
  constructor(readonly prices: PriceVersion[] = DEFAULT_PRICES, readonly directory?: string) {}

  /** Cached charges count as complete; only a failed scan or an empty ledger is partial.
   * @returns Coverage of the current totals, so callers can mark them without re-deriving the rule.
   */
  get coverage(): Coverage {
    if (this.scanning) return 'scanning';
    if (this.error) return 'partial';
    return this.scannedAt !== undefined || this.sessions.size > 0 ? 'complete' : 'partial';
  }

  /** Load immutable cut files, keeping the newest complete scan for each session. */
  async load(): Promise<void> {
    if (!this.directory) return;
    this.totals.clear();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json')) continue;
      let raw: string;
      try { raw = await readFile(join(this.directory, name), 'utf8'); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error; }
      const v = JSON.parse(raw) as Saved;
      if (v.version !== 1 || typeof v.sessionId !== 'string' || !Number.isSafeInteger(v.cut) || !Array.isArray(v.charges)
        || v.charges.some(c => !c || typeof c.key !== 'string' || typeof c.provider !== 'string' || typeof c.model !== 'string'
          || (c.amount !== undefined && (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount < 0))
          || (c.estimated !== undefined && c.estimated !== true)
          || (c.time !== undefined && (typeof c.time !== 'number' || !Number.isFinite(c.time) || c.time < 0 || c.time > 8.64e15))
          || (c.usage !== undefined && Object.values(c.usage).some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)))) throw new Error('Invalid cost ledger');
      for (const c of v.charges) if (c.price) pricesFrom([c.price]);
      if ((this.sessions.get(v.sessionId)?.cut ?? -2) <= v.cut) this.sessions.set(v.sessionId, v);
    }
  }

  /** Replace one session using all billing events through the opening snapshot cut.
   * @param sessionId - Host session identity.
   * @param cut - Opening cursor, preventing a stale scan from overwriting a newer scan.
   * @param events - Minimal events returned by costRecords, across all history pages.
   */
  async replace(sessionId: string, cut: number, events: ObjectValue[]): Promise<void> {
    if ((this.sessions.get(sessionId)?.cut ?? -2) > cut) return;
    const old = new Map(this.sessions.get(sessionId)?.charges.map(c => [c.key, c]));
    const charges: Charge[] = [];
    const inheritedCut = Math.max(-1, ...events.filter(e => e.type === 'session/end-seed' && object(e.data).inherited === true).map(e => Number(e.seq)));
    let route: ObjectValue = {}; let last: { turn: unknown; step: unknown; index: number } | undefined;
    for (const e of [...new Map(events.map(e => [Number(e.seq), e])).values()].sort((a, b) => Number(a.seq) - Number(b.seq))) {
      const d = object(e.data);
      if (e.type === 'request/context') { route = d; continue; }
      if (Number(e.seq) <= inheritedCut || e.type === 'session/end-seed') continue;
      if (e.type === 'llm/retry-started') {
        if (last?.turn === d.turn && last?.step === d.step) last = undefined;
        continue;
      }
      const source = object(d.source ?? {}); const provider = String(source.provider ?? route.provider ?? ''); const model = String(source.model ?? route.model ?? '');
      const time = typeof e.time === 'number' && Number.isFinite(e.time) && e.time >= 0 && e.time <= 8.64e15 ? e.time : undefined;
      const u = object(d.usage ?? {});
      const buckets = [u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0];
      const valid = buckets.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
        && (u.totalTokens === undefined || typeof u.totalTokens === 'number' && Number.isSafeInteger(u.totalTokens) && u.totalTokens === buckets.reduce<number>((sum, n) => sum + Number(n), 0));
      const usage = valid ? { input: Number(buckets[0]), output: Number(buckets[1]), cacheRead: Number(buckets[2]), cacheWrite: Number(buckets[3]) } : undefined;
      const index = last && d.turn !== null && d.step !== null && last.turn === d.turn && last.step === d.step ? last.index : charges.length;
      const key = charges[index]?.key ?? String(e.seq);
      if (!usage && charges[index]?.usage) continue;
      const previous = old.get(key);
      if (previous?.amount !== undefined && previous.time === time && previous.provider === provider && previous.model === model
        && usage && previous.usage && Object.keys(usage).every(k => usage[k as keyof Usage] === previous.usage![k as keyof Usage])) {
        charges[index] = previous; last = { turn: d.turn, step: d.step, index }; continue;
      }
      const reusable = previous?.price && previous.provider === provider && previous.model === model ? [previous.price] : this.prices;
      const selected = time === undefined ? lowestPrice(reusable, provider, model) : priceAt(reusable, provider, model, time);
      const estimate = usage && selected ? (usage.input * selected.rates.input + usage.output * selected.rates.output + usage.cacheRead * selected.rates.cacheRead + usage.cacheWrite * selected.rates.cacheWrite) / 1e6 : undefined;
      const amount = estimate !== undefined && Number.isFinite(estimate) ? estimate : undefined;
      charges[index] = { key, time, provider, model, usage, price: selected?.price, amount,
        ...(time === undefined && amount !== undefined ? { estimated: true as const } : {}),
        reason: !usage ? 'missing usage' : time === undefined ? 'missing timestamp, floor rate' : !selected ? 'no price version' : amount === undefined ? 'invalid estimate' : undefined };
      last = { turn: d.turn, step: d.step, index };
    }
    const saved: Saved = { version: 1, sessionId, cut, charges };
    if (this.directory) {
      const prefix = createHash('sha256').update(sessionId).digest('hex') + '-';
      const filename = `${prefix}${cut}.json`; const temporary = join(this.directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(saved) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, join(this.directory, filename));
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      for (const name of await readdir(this.directory)) if (name.startsWith(prefix) && name.endsWith('.json') && Number(name.slice(prefix.length, -5)) < cut) {
        await unlink(join(this.directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    this.sessions.set(sessionId, saved);
    this.totals.clear();
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

  /** Summarize cached requests across one session or Beijing calendar days.
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
