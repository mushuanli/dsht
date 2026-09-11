/** Fixed-time billing examples, isolated ledger storage and HTTP history refresh. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostLedger, DEFAULT_PRICES, pricesFrom, priceAt, lowestPrice, costRecords, costDay, costText, type CostTotal } from '../../src/cost/ledger.ts';
import { Controller, costAddresses } from '../../src/controller/controller.ts';
import { host, until } from '../support/host.ts';
import type { ObjectValue } from '../../src/transport/wire.ts';

const at = (date: string) => Date.parse(date + '+08:00');
const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
function record(seq: number, time: number, step = seq, model = 'deepseek-v4-flash', provider = 'deepseek-official'): ObjectValue {
  return { type: 'event', event: { seq, time, type: 'assistant/message', data: { turn: 1, step, usage,
    message: { source: { provider, model }, content: [{ type: 'text', text: 'PRIVATE PROMPT' }] } } } };
}
/** Compare money at the precision the terminal displays instead of raw float bits. */
const summary = (total: CostTotal) => ({ ...total, amount: Number(total.amount.toFixed(4)) });

test('tariffs use Beijing weekdays and half-open morning/afternoon windows', () => {
  const prices = pricesFrom(DEFAULT_PRICES);
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

test('bundled rates match the published tables, including the V4 Pro handover to Flash billing', () => {
  const prices = pricesFrom(DEFAULT_PRICES);
  const rates = (model: string, date: string) => priceAt(prices, 'deepseek-official', model, at(date))?.rates;
  assert.deepEqual(rates('deepseek-flash', '2026-09-10T10:00:00'), { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 });
  assert.deepEqual(rates('deepseek-flash', '2026-09-10T20:00:00'), { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 });
  assert.deepEqual(rates('deepseek-v4-pro', '2026-09-10T10:00:00'), { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 });
  assert.deepEqual(rates('deepseek-v4-pro', '2026-09-10T20:00:00'), { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 });
  // 2026-09-14T12:00+08:00 is the announced handover: the same model name is then billed as Flash.
  assert.deepEqual(rates('deepseek-v4-pro', '2026-09-14T11:59:59'), { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 });
  assert.deepEqual(rates('deepseek-v4-pro', '2026-09-15T10:00:00'), { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 });
});

test('an unlisted model uses its name family, and an unlisted provider stays unpriced', () => {
  const prices = pricesFrom(DEFAULT_PRICES);
  assert.equal(priceAt(prices, 'deepseek-official', 'some-FLASH-preview', at('2026-09-10T10:00:00'))?.rates.input, 2);
  assert.equal(priceAt(prices, 'deepseek-official', 'some-Pro-preview', at('2026-09-10T10:00:00'))?.rates.input, 9);
  assert.equal(priceAt(prices, 'other', 'deepseek-flash', at('2026-09-10T10:00:00')), undefined);
  assert.deepEqual(lowestPrice(prices, 'deepseek-official', 'deepseek-v4-pro')?.rates, { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 });
  assert.equal(lowestPrice(prices, 'other', 'deepseek-flash'), undefined);
});

test('a request without a settlement time keeps a floor amount and stays estimated', async () => {
  const ledger = new CostLedger();
  const undated = record(0, at('2026-09-10T10:00:00')); delete (undated.event as ObjectValue).time;
  await ledger.replace('s1', 0, costRecords([undated]));
  const total = ledger.total('s1');
  assert.equal(summary(total).amount, 5.02);
  assert.deepEqual({ unknown: total.unknown, estimated: total.estimated, records: total.records }, { unknown: 0, estimated: 1, records: 1 });
  assert.equal(costText(total), '~¥5.0200*');
  // A calendar range cannot place an undated request, so it is counted but not added.
  assert.deepEqual(summary(ledger.total(undefined, 1, at('2026-09-10T12:00:00'))), { amount: 0, unknown: 0, estimated: 1, records: 1 });
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
  assert.deepEqual(summary(ledger.total('s1')), { amount: 30.12, unknown: 1, estimated: 0, records: 5 });
  assert.deepEqual(summary(ledger.total(undefined, 1, now)), { amount: 5.02, unknown: 0, estimated: 0, records: 1 });
  assert.deepEqual(summary(ledger.total(undefined, 3, now)), { amount: 10.04, unknown: 1, estimated: 0, records: 3 });
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
  assert.deepEqual(summary(ledger.total('fork')), { amount: 5.02, unknown: 0, estimated: 0, records: 1 });
});

test('every scan reprices stored requests from the current table and stores no conversation text', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cost-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new CostLedger(DEFAULT_PRICES, directory); await ledger.load();
  const events = costRecords([record(0, at('2026-09-10T10:00:00'))]);
  await ledger.replace('s1', 0, events);
  assert.equal(summary(ledger.total('s1')).amount, 10.04);
  const changed = DEFAULT_PRICES.map(p => ({ ...p, peak: { ...p.peak, input: 999 } }));
  const restarted = new CostLedger(changed, directory); await restarted.load();
  await restarted.replace('s1', 1, events);
  assert.equal(summary(restarted.total('s1')).amount, 1007.04);
  const files = await readdir(directory); assert.equal(files.length, 1);
  assert.doesNotMatch(await readFile(join(directory, files[0]!), 'utf8'), /PRIVATE PROMPT|content/);
});

test('a renamed table reprices charges an earlier scan already priced', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cost-')); t.after(() => rm(directory, { recursive: true, force: true }));
  // The 2026-09-10 correction renamed the Flash model and lowered its rates, which left stored
  // charges matching neither the recorded alias nor the new family name.
  const legacy = { ...DEFAULT_PRICES[0]!, id: 'deepseek-2026-09-10-deepseek-v4-flash', model: 'deepseek-v4-flash',
    peak: { input: 3, cacheRead: 0.1, cacheWrite: 3, output: 9 },
    offPeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 } };
  const events = costRecords([record(0, at('2026-09-10T10:00:00'))]);
  const before = new CostLedger(pricesFrom([legacy]), directory); await before.load();
  await before.replace('s1', 0, events);
  assert.equal(summary(before.total('s1')).amount, 12.1);
  const after = new CostLedger(DEFAULT_PRICES, directory); await after.load();
  await after.replace('s1', 1, events);
  assert.equal(summary(after.total('s1')).amount, 10.04);
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
  assert.deepEqual(summary(ledger.total('s1')), { amount: 29.1, unknown: 1, estimated: 1, records: 4 });
  assert.deepEqual(summary(ledger.total(undefined, 1, at('2026-09-11T12:00:00'))), { amount: 14.04, unknown: 1, estimated: 1, records: 3 });
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
  await ledger.replace('s1', 1, costRecords([
    { type: 'event', event: { seq: 0, type: 'request/context', data: { provider: 'deepseek-official', model: 'preview-PRO' } } },
    { type: 'event', event: { seq: 1, time: at('2026-09-10T10:00:00'), type: 'assistant/attempt', data: { turn: 1, step: 1,
      stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { ...usage, inputTokens: 1 } } }, { type: 'chunk', chunk: { type: 'usage', usage } }] } } },
  ]));
  assert.equal(summary(ledger.total('s1')).amount, 36.3);
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

test('one failing session does not stop the others from being repriced', async t => {
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
