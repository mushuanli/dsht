/** Fixed-time billing examples, isolated ledger storage and HTTP history refresh. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostLedger, DEFAULT_PRICES, pricesFrom, priceAt, costRecords, costDay } from '../src/cost.ts';
import { Controller } from '../src/controller.ts';
import { host, until } from './host.ts';
import type { ObjectValue } from '../src/wire.ts';

const at = (date: string) => Date.parse(date + '+08:00');
const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
function record(seq: number, time: number, step = seq, model = 'deepseek-v4-flash', provider = 'deepseek-official'): ObjectValue {
  return { type: 'event', event: { seq, time, type: 'assistant/message', data: { turn: 1, step, usage,
    message: { source: { provider, model }, content: [{ type: 'text', text: 'PRIVATE PROMPT' }] } } } };
}

test('tariffs use Beijing weekdays and half-open morning/afternoon windows', () => {
  const prices = pricesFrom(DEFAULT_PRICES);
  const rate = (time: string) => priceAt(prices, 'deepseek-official', 'deepseek-v4-flash', at(time))?.rates.input;
  assert.equal(rate('2026-09-10T08:59:59'), 1.5);
  assert.equal(rate('2026-09-10T09:00:00'), 3);
  assert.equal(rate('2026-09-10T12:00:00'), 1.5);
  assert.equal(rate('2026-09-10T14:00:00'), 3);
  assert.equal(rate('2026-09-10T18:00:00'), 1.5);
  assert.equal(rate('2026-09-12T10:00:00'), 1.5);
  assert.equal(rate('2026-09-09T10:00:00'), undefined);
  assert.equal(priceAt(prices, 'deepseek-official', 'deepseek-v4.1-flash-expires-on-0910', at('2026-09-10T10:00:00'))?.rates.input, 3);
  assert.equal(priceAt(prices, 'deepseek-official', 'deepseek-v4.1-PRO-preview', at('2026-09-10T10:00:00'))?.rates.input, 9);
  const exact = { ...prices[0]!, id: 'custom', model: 'custom-model', peak: { ...prices[0]!.peak, input: 42 } };
  assert.equal(priceAt(pricesFrom([...prices, exact]), 'deepseek-official', 'custom-model', at('2026-09-10T10:00:00'))?.rates.input, 42);
  assert.equal(costDay(Date.parse('2026-09-10T16:00:00Z')), '2026-09-11');
  assert.throws(() => pricesFrom([...prices, { ...prices[0], id: 'overlap' }]), /Overlapping/);
  assert.throws(() => pricesFrom([{ ...prices[0], peak: { input: -1 } }]), /rate/);
  assert.throws(() => pricesFrom([{ ...prices[0], windows: [[720, 540]] }]), /schedule/);
});

test('session, today and three-calendar-day costs retain unknowns and avoid replacement/retry duplication', async () => {
  const ledger = new CostLedger();
  const records = [record(0, at('2026-09-10T10:00:00')), record(1, at('2026-09-10T11:00:00'), 0),
    { type: 'event', event: { seq: 2, type: 'llm/retry-started', data: { turn: 1, step: 0 } } },
    record(3, at('2026-09-10T11:01:00'), 0), record(4, at('2026-09-11T20:00:00')),
    record(5, at('2026-09-12T10:00:00'), 5, 'unknown', 'other'), record(6, at('2026-09-13T10:00:00'))];
  await ledger.replace('s1', 6, costRecords(records));
  const now = at('2026-09-13T12:00:00');
  assert.deepEqual(ledger.total('s1'), { amount: 36.3, unknown: 1, records: 5 });
  assert.deepEqual(ledger.total(undefined, 1, now), { amount: 6.05, unknown: 0, records: 1 });
  assert.deepEqual(ledger.total(undefined, 3, now), { amount: 12.1, unknown: 1, records: 3 });
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
  assert.deepEqual(ledger.total('fork'), { amount: 6.05, unknown: 0, records: 1 });
});

test('ledger restart retains rates and stores no conversation text', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cost-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new CostLedger(DEFAULT_PRICES, directory); await ledger.load();
  const events = costRecords([record(0, at('2026-09-10T10:00:00'))]);
  await ledger.replace('s1', 0, events);
  const changed = DEFAULT_PRICES.map(p => ({ ...p, peak: { ...p.peak, input: 999 } }));
  const restarted = new CostLedger(changed, directory); await restarted.load();
  await restarted.replace('s1', 1, events);
  assert.equal(restarted.total('s1').amount, 12.1);
  const files = await readdir(directory); assert.equal(files.length, 1);
  assert.doesNotMatch(await readFile(join(directory, files[0]!), 'utf8'), /PRIVATE PROMPT|content/);
});

test('billing scans all HTTP sessions without changing the selected session', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.followSnapshot = { type: 'snapshot', cursor: 0, hasMore: false, header: { id: 's1' }, records: [record(0, at('2026-09-10T10:00:00'))] };
  const ledger = new CostLedger();
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, ledger);
  t.after(() => controller.stop()); controller.start();
  await until(() => ledger.scannedAt !== undefined);
  assert.equal(controller.state.sessionId, 's1');
  assert.equal(ledger.total('s1').amount, 12.1);
  assert.equal(ledger.total().amount, 24.2);
  assert.equal(fixture.calls.some(c => c.method === 'session/prompt'), false);
});

test('price updates select new intervals and missing timestamp or inconsistent usage stays unpriced', async () => {
  const original = DEFAULT_PRICES[0]!;
  const prices = pricesFrom([{ ...original, until: '2026-09-11T00:00:00+08:00' },
    { ...original, id: 'new', from: '2026-09-11T00:00:00+08:00', peak: { ...original.peak, input: 6 } }]);
  const ledger = new CostLedger(prices);
  const unknownTime = record(2, at('2026-09-11T10:00:00')); delete (unknownTime.event as ObjectValue).time;
  const invalid = record(3, at('2026-09-11T10:00:00'));
  ((invalid.event as ObjectValue).data as ObjectValue).usage = { ...usage, totalTokens: 1 };
  await ledger.replace('s1', 3, costRecords([record(0, at('2026-09-10T10:00:00')), record(1, at('2026-09-11T10:00:00')), unknownTime, invalid]));
  assert.deepEqual(ledger.total('s1'), { amount: 27.2, unknown: 2, records: 4 });
  assert.equal(ledger.total(undefined, 1, at('2026-09-11T12:00:00')).unknown, 2);
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
  assert.equal(ledger.total('s1').amount, 36.3);
});
