/** Fixed-time billing examples, isolated ledger storage and HTTP history refresh. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostLedger, DEFAULT_PRICES, PRICING_ENGINE_VERSION, pricesFrom, priceAt, chargeFor, candidates, canonicalModel, costRecords, costAddresses, costDay, costText, type CostTotal } from '../../src/cost/index.ts';
import { Controller } from '../../src/controller/controller.ts';
import { host, until } from '../support/host.ts';
import type { ObjectValue } from '../../src/transport/wire.ts';

const at = (date: string) => Date.parse(date + '+08:00');
const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
/** What one `record()` costs under the shipped Flash table: 2 + 8 + 0.04 peak, half that off peak. */
const PEAK = 10.04; const OFF_PEAK = 5.02;
/** A private copy of the shipped table: `pricesFrom` returns the array it is given, so a test that
 * edits or splices its table would otherwise change the module-level one for every later test. */
const shipped = () => pricesFrom(DEFAULT_PRICES.map(price => ({ ...price })));
function record(seq: number, time: number, step = seq, model = 'deepseek-v4-flash', provider = 'deepseek-official'): ObjectValue {
  return { type: 'event', event: { seq, time, type: 'assistant/message', data: { turn: 1, step, usage,
    message: { source: { provider, model }, content: [{ type: 'text', text: 'PRIVATE PROMPT' }] } } } };
}
/** Compare money at the precision the terminal displays instead of raw float bits. */
const summary = (total: CostTotal) => ({ ...total, amount: Number(total.amount.toFixed(4)) });

test('tariffs use Beijing weekdays and half-open morning/afternoon windows', () => {
  const prices = shipped();
  const rate = (time: string) => priceAt(prices, 'deepseek-official', 'deepseek-v4-flash', at(time))?.rates.input;
  assert.equal(rate('2026-09-10T08:59:59'), 1);
  assert.equal(rate('2026-09-10T09:00:00'), 2);
  assert.equal(rate('2026-09-10T12:00:00'), 1);
  assert.equal(rate('2026-09-10T14:00:00'), 2);
  assert.equal(rate('2026-09-10T18:00:00'), 1);
  assert.equal(rate('2026-09-12T10:00:00'), 1);
  assert.equal(rate('2026-09-09T10:00:00'), undefined);
  assert.equal(priceAt(prices, 'deepseek-official', 'deepseek-v4.1-flash-expires-on-0910', at('2026-09-10T10:00:00'))?.rates.input, 2);
  assert.equal(priceAt(prices, 'deepseek-official', 'deepseek-v4.1-PRO-preview', at('2026-09-10T10:00:00'))?.rates.input, 9);
  const exact = { ...prices[0]!, id: 'custom', model: 'custom-model', peak: { ...prices[0]!.peak, input: 42 } };
  assert.equal(priceAt(pricesFrom([...prices, exact]), 'deepseek-official', 'custom-model', at('2026-09-10T10:00:00'))?.rates.input, 42);
  assert.equal(costDay(Date.parse('2026-09-10T16:00:00Z')), '2026-09-11');
  assert.throws(() => pricesFrom([...prices, { ...prices[0], id: 'overlap' }]), /Overlapping/);
  assert.throws(() => pricesFrom([{ ...prices[0], peak: { input: -1 } }]), /rate/);
  assert.throws(() => pricesFrom([{ ...prices[0], windows: [[720, 540]] }]), /schedule/);
});

test('bundled rates match the published tables, and V4 Pro keeps its own rates', () => {
  const prices = shipped();
  const rates = (model: string, date: string) => priceAt(prices, 'deepseek-official', model, at(date))?.rates;
  assert.deepEqual(rates('deepseek-flash', '2026-09-10T10:00:00'), { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 });
  assert.deepEqual(rates('deepseek-flash', '2026-09-10T20:00:00'), { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 });
  assert.deepEqual(rates('deepseek-v4-pro', '2026-09-10T10:00:00'), { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 });
  assert.deepEqual(rates('deepseek-v4-pro', '2026-09-10T20:00:00'), { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 });
  // The published table keeps V4 Pro on its own rates past 2026-09-14, so the interval stays open.
  assert.deepEqual(rates('deepseek-v4-pro', '2026-09-15T10:00:00'), { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 });
  assert.deepEqual(rates('deepseek-v4-pro', '2026-10-01T20:00:00'), { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 });
  // Superseded model names stay callable and are served by V4.1-Flash at Flash rates.
  for (const alias of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash-expires-on-0910']) {
    assert.deepEqual(rates(alias, '2026-09-10T20:00:00'), { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }, alias);
  }
});

test('a model the table does not cover stays unpriced instead of being guessed at', () => {
  const prices = shipped();
  // A name that merely contains "pro" is not Pro, and a name that contains neither is not Flash.
  for (const model of ['deepseek-proxy-preview', 'deepseek-v5-ultra', 'some-FLASH-preview', 'some-Pro-preview']) {
    // A name the table does not declare is not guessed at, however it is spelled.
    assert.equal(priceAt(prices, 'deepseek-official', model, at('2026-09-10T10:00:00')), undefined, model);
  }
  // A name containing "pro" inside another word is not Pro: the declared prefixes decide, so a
  // Flash prefix still resolves to Flash rather than flipping to the Pro rates.
  for (const model of ['deepseek-v4-flash-prod', 'deepseek-v4-flash-anything']) {
    const match = priceAt(prices, 'deepseek-official', model, at('2026-09-10T10:00:00'));
    assert.equal(match?.price.model, 'deepseek-flash', model);
    assert.equal(match?.matchedBy, 'alias');
  }
  assert.equal(priceAt(prices, 'other', 'deepseek-flash', at('2026-09-10T10:00:00')), undefined);
  // A declared alias still resolves, and the rule that matched it is reported.
  assert.equal(priceAt(prices, 'deepseek-official', 'deepseek-v4.1-flash-expires-on-0910', at('2026-09-10T10:00:00'))?.matchedBy, 'alias');
  assert.equal(priceAt(prices, 'deepseek-official', 'deepseek-flash', at('2026-09-10T10:00:00'))?.matchedBy, 'exact');
  assert.deepEqual(candidates(prices, 'deepseek-official', 'deepseek-flash').map(c => c.matchedBy), ['exact']);
});

test('model names match after normalization, including the CJK full stop a host can substitute', () => {
  assert.equal(canonicalModel(' DeepSeek-V4.1-Flash '), 'deepseek-v4.1-flash');
  assert.equal(canonicalModel('deepseek-v4。1-flash'), 'deepseek-v4.1-flash');
  assert.equal(canonicalModel('deepseek-v4．1－flash'.replace('－', '-')), 'deepseek-v4.1-flash');
  const prices = shipped();
  assert.equal(priceAt(prices, 'deepseek-official', 'deepseek-v4。1-flash-expires-on-0910', at('2026-09-10T20:00:00'))?.rates.input, 1);
  assert.equal(priceAt(prices, 'deepseek-official', 'DEEPSEEK-V4.1-FLASH-EXPIRES-ON-0910', at('2026-09-10T20:00:00'))?.rates.input, 1);
});

test('an amount records the rule that matched, the engine, and a digest of the rates used', () => {
  const prices = shipped();
  const decision = chargeFor(prices, 'deepseek-official', 'deepseek-v4.1-flash-expires-on-0910', at('2026-09-10T10:00:00'),
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(decision.matchedBy, 'alias');
  assert.equal(decision.engine, PRICING_ENGINE_VERSION);
  assert.match(String(decision.catalog), /^[0-9a-f]{12}$/);
  // Editing a rate under the same id changes the digest, which is what identifies the rates used.
  const edited = pricesFrom([{ ...prices[0]!, peak: { ...prices[0]!.peak, input: 3 } }, prices[1]!]);
  const after = chargeFor(edited, 'deepseek-official', 'deepseek-flash', at('2026-09-10T10:00:00'), { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.notEqual(after.catalog, decision.catalog);
});

test('a cache-write bucket the published table does not price stays unresolved', () => {
  const prices = shipped();
  const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 1_000_000 };
  assert.deepEqual(chargeFor(prices, 'deepseek-official', 'deepseek-flash', at('2026-09-10T10:00:00'), usage), { reason: 'unsupported usage' });
  // Another provider may price the bucket, so the rule is scoped to the published DeepSeek table.
  const other = pricesFrom([{ ...prices[0]!, provider: 'other' }]);
  assert.equal(chargeFor(other, 'other', 'deepseek-flash', at('2026-09-10T10:00:00'), usage).amount, 4);
});

test('a request without a settlement time is unresolved, so the day subtotals still add up', async () => {
  const ledger = new CostLedger();
  const dated = record(0, at('2026-09-10T10:00:00'));
  const undated = record(1, at('2026-09-10T10:00:00')); delete (undated.event as ObjectValue).time;
  await ledger.replace('s1', 1, costRecords([dated, undated]));
  const total = ledger.total('s1');
  // The peak band differs by a factor of two, so a guessed floor would be a wrong number either way.
  assert.deepEqual(summary(total), { amount: PEAK, unknown: 1, records: 2 });
  assert.equal(costText(total), '~¥10.0400*');
  // The unresolved request cannot inflate a day: the day subtotals add up to the lifetime total.
  assert.deepEqual(summary(ledger.total(undefined, 1, at('2026-09-10T12:00:00'))), { amount: PEAK, unknown: 1, records: 2 });
  assert.equal(ledger.total(undefined, 1, at('2026-09-10T12:00:00')).amount, ledger.total().amount);
});

test('a summary request is billed from its own route and usage', async () => {
  const ledger = new CostLedger();
  const summary = { type: 'event', event: { seq: 0, time: at('2026-09-10T20:00:00'), type: 'compaction/summary',
    data: { compactionId: 'c1', provider: 'deepseek-official', model: 'deepseek-v4.1-flash-expires-on-0910',
      usage: { inputTokens: 760_245, outputTokens: 3_312, cacheReadTokens: 11_904, totalTokens: 775_461 } } } };
  await ledger.replace('s1', 0, costRecords([summary]));
  // 760245 x 1 + 11904 x 0.02 + 3312 x 4, off-peak, per million.
  assert.equal(Number(ledger.total('s1').amount.toFixed(4)), 0.7737);
  // A summary with no model call reports nothing to bill, so it is not a request at all.
  const template = { type: 'event', event: { seq: 1, time: at('2026-09-10T20:00:00'), type: 'compaction/summary', data: { compactionId: 'c2' } } };
  assert.deepEqual(costRecords([template]), []);
});

test('an unpriced charge is priced once a table covers it, and a priced charge never moves', async () => {
  const unknown = record(0, at('2026-09-10T10:00:00'), 0, 'deepseek-v5-ultra');
  const prices = shipped();
  const ledger = new CostLedger(prices);
  await ledger.replace('s1', 0, costRecords([unknown]));
  assert.deepEqual(summary(ledger.total('s1')), { amount: 0, unknown: 1, records: 1 });
  // A later table that covers the model prices the same stored sample without a reprice.
  const covered = new CostLedger(pricesFrom([...prices, { ...prices[0]!, id: 'v5', model: 'deepseek-v5-ultra',
    aliases: undefined }]));
  await covered.replace('s1', 0, costRecords([unknown]));
  assert.equal(Number(covered.total('s1').amount.toFixed(4)), PEAK);
  // An amount already decided survives a table that would decide it differently.
  const kept = new CostLedger(shipped());
  const priced = costRecords([record(0, at('2026-09-10T10:00:00'))]);
  await kept.replace('s1', 0, priced);
  assert.equal(Number(kept.total('s1').amount.toFixed(4)), PEAK);
  kept.prices.splice(0, kept.prices.length, ...pricesFrom([{ ...prices[0]!, peak: { ...prices[0]!.peak, input: 1 } }]));
  await kept.replace('s1', 1, priced);
  assert.equal(Number(kept.total('s1').amount.toFixed(4)), PEAK);
  await kept.reprice();
  // Peak input is 1, so only the input term moves: 1 + 8 + 0.04.
  assert.equal(Number(kept.total('s1').amount.toFixed(4)), 9.04);
});

test('coverage reports missing data and failures without distrusting cached charges', async () => {
  const ledger = new CostLedger();
  assert.equal(ledger.coverage, 'partial');
  ledger.scanning = true;
  assert.equal(ledger.coverage, 'scanning');
  ledger.scanning = false;
  assert.equal(ledger.coverage, 'partial');
  await ledger.replace('s1', 1, costRecords([record(0, at('2026-09-10T10:00:00'))]));
  // Charges cached by an earlier run are complete coverage even before this run scans.
  assert.equal(ledger.coverage, 'complete');
  ledger.error = 'scan failed';
  assert.equal(ledger.coverage, 'partial');
});

test('session, today and three-calendar-day costs retain unknowns and avoid replacement/retry duplication', async () => {
  const ledger = new CostLedger();
  const records = [record(0, at('2026-09-10T10:00:00')), record(1, at('2026-09-10T11:00:00'), 0),
    { type: 'event', event: { seq: 2, type: 'llm/retry-started', data: { turn: 1, step: 0 } } },
    record(3, at('2026-09-10T11:01:00'), 0), record(4, at('2026-09-11T20:00:00')),
    record(5, at('2026-09-12T10:00:00'), 5, 'unknown', 'other'), record(6, at('2026-09-13T10:00:00'))];
  await ledger.replace('s1', 6, costRecords(records));
  const now = at('2026-09-13T12:00:00');
  assert.deepEqual(summary(ledger.total('s1')), { amount: 30.12, unknown: 1, records: 5 });
  assert.deepEqual(summary(ledger.total(undefined, 1, now)), { amount: OFF_PEAK, unknown: 0, records: 1 });
  assert.deepEqual(summary(ledger.total(undefined, 3, now)), { amount: 10.04, unknown: 1, records: 3 });
  await ledger.replace('s1', 6, costRecords(records));
  assert.equal(ledger.total('s1').records, 5);
  await ledger.replace('s1', 0, []);
  assert.equal(ledger.total('s1').records, 5);
});

test('fork seed records are excluded while inherited request routes remain usable', async () => {
  const ledger = new CostLedger();
  const records = [record(0, at('2026-09-10T10:00:00')),
    { type: 'event', event: { seq: 1, type: 'session/end-seed', data: { inherited: true } } },
    record(2, at('2026-09-10T20:00:00'))];
  await ledger.replace('fork', 2, costRecords(records));
  assert.deepEqual(summary(ledger.total('fork')), { amount: OFF_PEAK, unknown: 0, records: 1 });
});

test('a decided charge keeps its amount when the price table changes and stores no conversation text', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cost-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new CostLedger(DEFAULT_PRICES, directory); await ledger.load();
  const events = costRecords([record(0, at('2026-09-10T10:00:00'))]);
  await ledger.replace('s1', 0, events);
  assert.equal(summary(ledger.total('s1')).amount, 10.04);
  // Editing prices.json cannot move an amount an earlier scan already decided.
  const changed = DEFAULT_PRICES.map(p => ({ ...p, peak: { ...p.peak, input: 999 } }));
  const restarted = new CostLedger(changed, directory); await restarted.load();
  await restarted.replace('s1', 1, events);
  assert.equal(summary(restarted.total('s1')).amount, 10.04);
  // A request first seen after the change is priced from the table loaded then.
  await restarted.replace('s1', 2, costRecords([record(0, at('2026-09-10T10:00:00')), record(1, at('2026-09-10T11:00:00'), 1)]));
  assert.equal(summary(restarted.total('s1')).amount, 1017.08);
  const files = await readdir(directory); assert.equal(files.length, 1);
  assert.doesNotMatch(await readFile(join(directory, files[0]!), 'utf8'), /PRIVATE PROMPT|content/);
});

test('a renamed table leaves an already decided charge at its recorded amount', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cost-')); t.after(() => rm(directory, { recursive: true, force: true }));
  // The 2026-09-10 correction renamed the Flash model and lowered its rates. The amount decided
  // before that correction is a historical fact, so the new table cannot move it.
  const legacy = { ...DEFAULT_PRICES[0]!, id: 'deepseek-2026-09-10-deepseek-v4-flash', model: 'deepseek-v4-flash',
    peak: { input: 3, cacheRead: 0.1, cacheWrite: 3, output: 9 },
    offPeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 } };
  const events = costRecords([record(0, at('2026-09-10T10:00:00'))]);
  const before = new CostLedger(pricesFrom([legacy]), directory); await before.load();
  await before.replace('s1', 0, events);
  assert.equal(summary(before.total('s1')).amount, 12.1);
  const after = new CostLedger(DEFAULT_PRICES, directory); await after.load();
  assert.equal(summary(after.total('s1')).amount, 12.1);
  await after.replace('s1', 1, events);
  assert.equal(summary(after.total('s1')).amount, 12.1);
});

test('a charge no table covered is priced once a table covers it, without a reprice', async () => {
  const ledger = new CostLedger([]);
  const events = costRecords([record(0, at('2026-09-10T10:00:00'), 0, 'unlisted-model', 'unlisted-provider')]);
  await ledger.replace('s1', 0, events);
  assert.deepEqual(summary(ledger.total('s1')), { amount: 0, unknown: 1, records: 1 });
  // An unpriced request stays open, so the next table that covers its model prices it in place.
  ledger.prices.push(...DEFAULT_PRICES.map(price => ({ ...price, provider: 'unlisted-provider', model: 'unlisted-model' })));
  await ledger.replace('s1', 1, events);
  assert.deepEqual(summary(ledger.total('s1')), { amount: PEAK, unknown: 0, records: 1 });
});

test('a sample without usage stays open until the host reports tokens', async () => {
  const ledger = new CostLedger();
  const attempt = { type: 'event', event: { seq: 0, type: 'assistant/attempt', data: { turn: 1, step: 0,
    message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } } } } };
  await ledger.replace('s1', 0, costRecords([attempt]));
  assert.equal(ledger.total('s1').unknown, 1);
  await ledger.replace('s1', 1, costRecords([attempt, record(1, at('2026-09-10T10:00:00'), 0)]));
  assert.equal(summary(ledger.total('s1')).amount, 10.04);
  assert.equal(ledger.total('s1').unknown, 0);
});

test('billing scans all HTTP sessions without changing the selected session', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 0, hasMore: false, header: { id: 's1' }, records: [record(0, at('2026-09-10T10:00:00'))] };
  const ledger = new CostLedger();
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, ledger);
  t.after(() => controller.stop()); controller.start();
  await until(() => ledger.scannedAt !== undefined);
  assert.equal(controller.state.sessionId, 's1');
  assert.equal(summary(ledger.total('s1')).amount, 10.04);
  assert.equal(summary(ledger.total()).amount, 20.08);
  assert.equal(fixture.calls.some(c => c.method === 'session/prompt'), false);
});

test('price updates select new intervals and inconsistent usage stays unpriced', async () => {
  const original = DEFAULT_PRICES[0]!;
  const prices = pricesFrom([{ ...original, until: '2026-09-11T00:00:00+08:00' },
    { ...original, id: 'new', from: '2026-09-11T00:00:00+08:00', peak: { ...original.peak, input: 6 } }]);
  const ledger = new CostLedger(prices);
  const unknownTime = record(2, at('2026-09-11T10:00:00')); delete (unknownTime.event as ObjectValue).time;
  const invalid = record(3, at('2026-09-11T10:00:00'));
  ((invalid.event as ObjectValue).data as ObjectValue).usage = { ...usage, totalTokens: 1 };
  await ledger.replace('s1', 3, costRecords([record(0, at('2026-09-10T10:00:00')), record(1, at('2026-09-11T10:00:00')), unknownTime, invalid]));
  // 10.04 at the first interval's peak, 6 + 8 + 0.04 at the second, and two unresolved requests.
  assert.deepEqual(summary(ledger.total('s1')), { amount: 24.08, unknown: 2, records: 4 });
  assert.deepEqual(summary(ledger.total(undefined, 1, at('2026-09-11T12:00:00'))), { amount: 14.04, unknown: 2, records: 3 });
});

test('cancelling a shared billing refresh aborts paging without cancelling the agent', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 10, hasMore: true, header: { id: 's1' }, records: [record(10, at('2026-09-10T10:00:00'))] };
  let requested = false; let release: (() => void) | undefined;
  fixture.onPage = async () => { requested = true; await new Promise<void>(resolve => { release = resolve; }); return { records: [], hasMore: false }; };
  const ledger = new CostLedger();
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, ledger);
  t.after(async () => { release?.(); await controller.stop(); }); controller.start();
  await until(() => requested);
  const abort = new AbortController(); const refresh = controller.refreshCosts(abort.signal);
  abort.abort(); await refresh;
  assert.equal(ledger.scanning, false);
  assert.equal(ledger.scannedAt, undefined);
  assert.ok(ledger.error);
  assert.equal(ledger.hasSession('s1'), false);
  assert.equal(fixture.calls.some(c => c.method === 'session/cancel'), false);
});

test('failed attempt stream usage uses its request route and last sample', async () => {
  const ledger = new CostLedger();
  const attempt = (model: string): ObjectValue[] => costRecords([
    { type: 'event', event: { seq: 0, type: 'request/context', data: { provider: 'deepseek-official', model } } },
    { type: 'event', event: { seq: 1, time: at('2026-09-10T10:00:00'), type: 'assistant/attempt', data: { turn: 1, step: 1,
      stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { ...usage, inputTokens: 1 } } }, { type: 'chunk', chunk: { type: 'usage', usage } }] } } },
  ]);
  // The attempt names no route of its own, so it is priced from the context in force, at its last usage chunk.
  await ledger.replace('s1', 1, attempt('deepseek-v4-pro'));
  assert.equal(summary(ledger.total('s1')).amount, 36.3);
  // A route the table does not declare stays unpriced instead of falling back to a name family.
  await ledger.replace('s2', 1, attempt('preview-PRO'));
  assert.deepEqual(summary(ledger.total('s2')), { amount: 0, unknown: 1, records: 1 });
});

test('subagent list rows yield the parent address in both delivery modes', () => {
  assert.deepEqual(costAddresses({ sessionId: 's1' }), [{ kind: 'session', sessionId: 's1' }]);
  assert.deepEqual(costAddresses({ sessionId: 'c', origin: 'subagent', parentSessionId: 'p' }), [
    { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' },
    { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'one-shot' },
  ]);
  // A child row without a parent cannot be addressed as a subagent, so it stays a plain session.
  assert.deepEqual(costAddresses({ sessionId: 'c', origin: 'subagent' }), [{ kind: 'session', sessionId: 'c' }]);
});

test('a subagent session is read under its parent address and its other delivery mode', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 1, hasMore: false, header: { id: 'child' }, records: [record(0, at('2026-09-10T10:00:00'))] };
  fixture.subagent = { sessionId: 'child', updatedAt: 1, running: false, origin: 'subagent', parentSessionId: 'parent' };
  // The list omits the delivery mode, so the continuable form is rejected before the scan succeeds.
  fixture.subagentMode = 'one-shot';
  const ledger = new CostLedger();
  const controller = new Controller(fixture.url, 'fixture-token', undefined, undefined, undefined, ledger);
  t.after(() => controller.stop()); controller.start();
  await until(() => ledger.scannedAt !== undefined);
  assert.equal(ledger.total('child').records, 1);
  assert.equal(ledger.error, '');
});

test('one failing session does not stop the others from being scanned', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 1, hasMore: false, header: { id: 's1' }, records: [record(0, at('2026-09-10T10:00:00'))] };
  fixture.failFollow = new Set(['s2']);
  const ledger = new CostLedger();
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, ledger);
  t.after(() => controller.stop()); controller.start();
  await until(() => ledger.scannedAt !== undefined);
  assert.ok(ledger.total('s1').records > 0);
  assert.equal(ledger.hasSession('s2'), false);
  assert.match(ledger.error, /1 of 2 sessions failed: s2/);
});
