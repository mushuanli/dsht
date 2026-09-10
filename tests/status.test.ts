/** Exact host telemetry formatting and replacement semantics, independent of clock scheduling. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactStatus, metricLines, elapsedTime } from '../src/status.tsx';
import wrapAnsi from 'wrap-ansi';
import { Telemetry } from '../src/telemetry.ts';

test('shows current and pending models, approximate occupancy and disjoint usage totals', () => {
  const values = {
    modelSelection: { lastUsed: { provider: 'p', model: 'current' }, next: { provider: 'p', model: 'next', reasoningEffort: 'high' } },
    contextPressure: { pressureTokens: 10, projectedTokens: 25, contextWindow: 100 },
    tokenUsage: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 },
  };
  assert.deepEqual(metricLines(values, undefined, true), [
    'Model: p/current · Next: p/next (high)',
    'Context: ~25% (25 / 100) · Tokens: 1,000 total',
    'In (uncached): 100 · Out: 200 · Cache read/write: 300/400',
  ]);
  assert.equal(metricLines(values, undefined, false)[0], 'Model: p/next (high)');
  assert.equal(metricLines({}, { provider: 'default', model: 'chat' }, false)[0], 'Model: default/chat');
  assert.deepEqual(metricLines({}, undefined, false).slice(1), [
    'Context: unknown · Tokens: ? total', 'In (uncached): ? · Out: ? · Cache read/write: ?/?',
  ]);
  assert.match(metricLines({ contextPressure: { pressureTokens: 200, contextWindow: 100 } }, undefined, false)[1]!, /~100%/);
  assert.match(metricLines({ contextPressure: { pressureTokens: 200, contextWindow: 0 } }, undefined, false)[1]!, /unknown/);
});

test('projection snapshots preserve newer keys, remove absent capabilities and reset on reconnect', () => {
  const telemetry = new Telemetry();
  assert.throws(() => telemetry.accept({ type: 'queue', sessionId: 's', items: [] }), /before baseline/);
  telemetry.accept({ type: 'baseline', value: { projections: { s: { asOfSeq: 10, values: { tokenUsage: 1, contextPressure: 2 } } },
    queues: { s: [1, 2] }, jobs: { s: [{ status: 'running' }, { status: 'completed' }] } } });
  telemetry.accept({ type: 'projection', sessionId: 's', key: 'tokenUsage', seq: 20, value: 3 });
  telemetry.snapshot('s', { asOfSeq: 15, values: { tokenUsage: 2 } });
  assert.deepEqual({ ...telemetry.view('s').values }, { tokenUsage: 3 });
  telemetry.accept({ type: 'projection', sessionId: 's', key: 'contextPressure', seq: 14, value: 999 });
  assert.equal(telemetry.view('s').values.contextPressure, undefined);
  assert.equal(telemetry.view('s').queued, 2);
  assert.equal(telemetry.view('s').jobs, 1);
  telemetry.accept({ type: 'queue', sessionId: 's', items: [] });
  telemetry.accept({ type: 'jobs', sessionId: 's', items: [{ status: 'stopping' }] });
  assert.equal(telemetry.view('s').queued, 0);
  telemetry.accept({ type: 'baseline', value: { projections: {}, queues: {}, jobs: {} } });
  assert.deepEqual(telemetry.view('s').values, {});
  assert.equal(telemetry.view('s').queued, undefined);
  assert.throws(() => telemetry.snapshot('s', { asOfSeq: 'bad', values: {} }), /watermark/);
  assert.throws(() => telemetry.accept({ type: 'projection', sessionId: 's', key: 'x', seq: 2 }), /Missing/);
});

test('working duration handles minutes, hours and clock skew', () => {
  assert.equal(elapsedTime(-1000), '0m 0s');
  assert.equal(elapsedTime(65_999), '1m 5s');
  assert.equal(elapsedTime(3_661_000), '1h 1m 1s');
});

test('single-row status keeps core metrics visible and shortens wide names before dropping details', () => {
  const fields = ['Working 1m 5s', 'deepseek-v4.1-flash-expires-on-0910 (high)', 'ws: 中文工作区名称很长', 'ctx: ~25%', 'tok: 1K', 'in/out: 100/200', '/status'];
  const wide = compactStatus(fields, 200);
  assert.equal(wide, fields.join(' · '));
  for (const width of [60, 80, 100]) {
    const row = compactStatus(fields, width);
    assert.equal(wrapAnsi(row, width, { hard: true, wordWrap: false }).includes('\n'), false);
    assert.match(row, /ctx: ~25%.*tok: 1K/);
  }
  assert.equal(compactStatus(['name\nnewline\tvalue'], 100), 'name newline value');
  assert.equal(compactStatus(fields, 1), '…');
});
