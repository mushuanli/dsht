/** Fold host history records into per-request samples; conversation text never enters the ledger. */
import { array, object, type Json, type ObjectValue } from '../transport/wire.ts';
import type { ChargeSample, Usage } from './types.ts';

/** Host event types that carry billing-relevant usage or route context. */
const BILLING_EVENTS = new Set(['request/context', 'assistant/message', 'assistant/attempt', 'llm/retry-started', 'session/end-seed']);

/** Keep only billing-relevant fields; prompts, tool bodies, cookies and keys never enter the ledger.
 * @param records - One HTTP history page's records.
 * @returns Minimal durable events for a deterministic usage fold.
 */
export function costRecords(records: unknown): ObjectValue[] {
  return array(records).map(raw => object(object(raw).event)).filter(e => BILLING_EVENTS.has(String(e.type))).map(e => {
    const d = object(e.data); const m = object(d.message ?? {});
    const stream = array(d.stream ?? []).map(r => object(object(r).chunk ?? {})).filter(c => c.type === 'usage');
    return { seq: e.seq ?? null, time: e.time ?? null, type: e.type!, data: {
      inherited: d.inherited ?? false, turn: d.turn ?? null, step: d.step ?? null, provider: d.provider ?? null, model: d.model ?? null,
      source: m.source ?? null, usage: d.usage ?? stream.at(-1)?.usage ?? null,
    } };
  });
}

/** Fold minimal billing events into one sample per model attempt.
 *
 * A replacement sample in the same turn and step updates its attempt's sample, a retry starts a
 * new one, and fork-inherited records are excluded. The sample carries no amount: deciding one
 * belongs to the ledger, which records the decision once.
 * @param events - Minimal events returned by `costRecords`, across all history pages.
 * @returns Ordered samples with the last valid usage observed for each attempt.
 */
export function foldSamples(events: readonly ObjectValue[]): ChargeSample[] {
  const inheritedCut = Math.max(-1, ...events.filter(e => e.type === 'session/end-seed' && object(e.data).inherited === true).map(e => Number(e.seq)));
  const samples: ChargeSample[] = [];
  let route: ObjectValue = {};
  let last: { turn: unknown; step: unknown; index: number } | undefined;
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
    const usage = validUsage(d.usage);
    const index = last && d.turn !== null && d.step !== null && last.turn === d.turn && last.step === d.step ? last.index : samples.length;
    if (!usage && samples[index]?.usage) continue;
    samples[index] = { key: samples[index]?.key ?? String(e.seq), ...(time === undefined ? {} : { time }), provider, model, ...(usage ? { usage } : {}) };
    last = { turn: d.turn, step: d.step, index };
  }
  return samples;
}

/** Accept a token report only when every bucket is a non-negative integer and totals agree. */
function validUsage(value: Json | undefined): Usage | undefined {
  const u = object(value ?? {});
  const buckets = [u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0];
  const valid = buckets.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
    && (u.totalTokens === undefined || typeof u.totalTokens === 'number' && Number.isSafeInteger(u.totalTokens) && u.totalTokens === buckets.reduce<number>((sum, n) => sum + Number(n), 0));
  return valid ? { input: Number(buckets[0]), output: Number(buckets[1]), cacheRead: Number(buckets[2]), cacheWrite: Number(buckets[3]) } : undefined;
}
