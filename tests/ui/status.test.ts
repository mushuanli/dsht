/** Exact host telemetry formatting and replacement semantics, independent of clock scheduling. */
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { cacheHitText, clockText, compactStatusRows, metricLines, elapsedTime, phaseText, type StatusGroups } from '../../src/ui/chat/status.tsx';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { Telemetry } from '../../src/session/telemetry.ts';

test('shows current and pending models, approximate occupancy and disjoint usage totals', () => {
  const values = {
    modelSelection: { lastUsed: { provider: 'p', model: 'current' }, next: { provider: 'p', model: 'next', reasoningEffort: 'high' } },
    contextPressure: { pressureTokens: 10, projectedTokens: 25, contextWindow: 100 },
    tokenUsage: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 },
  };
  assert.deepEqual(metricLines(values, undefined, true), [
    'Model: p/current · Next: p/next (high)',
    'Context ~25% (25/100) · 1K tok',
    'In 100 · Out 200 · Cache 300/400',
  ]);
  assert.equal(metricLines(values, undefined, false)[0], 'Model: p/next (high)');
  assert.equal(metricLines({}, { provider: 'default', model: 'chat' }, false)[0], 'Model: default/chat');
  assert.deepEqual(metricLines({}, undefined, false).slice(1), [
    'Context unknown · ? tok', 'In ? · Out ? · Cache ?/?',
  ]);
  assert.match(metricLines({ contextPressure: { pressureTokens: 200, contextWindow: 100 } }, undefined, false)[1]!, /~100%/);
  assert.match(metricLines({ contextPressure: { pressureTokens: 200, contextWindow: 0 } }, undefined, false)[1]!, /unknown/);
});

test('projection snapshots preserve newer keys, remove absent capabilities and reset on reconnect', () => {
  const telemetry = new Telemetry();
  assert.throws(() => telemetry.accept({ type: 'queue', sessionId: 's', items: [] }), /before baseline/);
  telemetry.accept({ type: 'baseline', value: { projections: { s: { asOfSeq: 10, values: { tokenUsage: 1, contextPressure: 2 } } },
    queues: { s: [1, 2].map(id => ({ id: String(id), placement: 'steering', message: { id: String(id), content: [{ type: 'text', text: `Pending ${id}` }] } })) }, jobs: { s: [{ status: 'running' }, { status: 'completed' }] } } });
  telemetry.accept({ type: 'projection', sessionId: 's', key: 'tokenUsage', seq: 20, value: 3 });
  telemetry.snapshot('s', { asOfSeq: 15, values: { tokenUsage: 2 } });
  assert.deepEqual({ ...telemetry.view('s').values }, { tokenUsage: 3 });
  telemetry.accept({ type: 'projection', sessionId: 's', key: 'contextPressure', seq: 14, value: 999 });
  assert.equal(telemetry.view('s').values.contextPressure, undefined);
  assert.equal(telemetry.view('s').queued, 2);
  assert.deepEqual(telemetry.pending('s').map(item => item.text), ['Pending 1', 'Pending 2']);
  assert.deepEqual(telemetry.pending('other'), []);
  assert.equal(telemetry.view('s').jobs, 1);
  telemetry.accept({ type: 'queue', sessionId: 's', items: [] });
  telemetry.accept({ type: 'jobs', sessionId: 's', items: [{ status: 'stopping' }] });
  assert.equal(telemetry.view('s').queued, 0);
  telemetry.accept({ type: 'baseline', value: { projections: {}, queues: {}, jobs: {} } });
  assert.deepEqual(telemetry.view('s').values, {});
  assert.equal(telemetry.view('s').queued, undefined);
  assert.deepEqual(telemetry.pending('s'), []);
  assert.throws(() => telemetry.snapshot('s', { asOfSeq: 'bad', values: {} }), /watermark/);
  assert.throws(() => telemetry.accept({ type: 'projection', sessionId: 's', key: 'x', seq: 2 }), /Missing/);
});

test('working duration handles minutes, hours and clock skew', () => {
  assert.equal(elapsedTime(-1000), '0s');
  assert.equal(elapsedTime(65_999), '1m 5s');
  assert.equal(elapsedTime(3_661_000), '1h 1m 1s');
});

/** The bar's groups as the component builds them, so the ladder can be asserted on its own. */
function groups(overrides: Partial<StatusGroups> = {}): StatusGroups {
  const segment = (text: string) => ({ text });
  return {
    state: segment('◐ 0:08'), phase: segment('bash 12s'), stop: segment('^C'), cost: segment('¥: 1.23(5.00)'),
    context: segment('ctx 25%'), contextBar: segment('ctx: ███░░░░░░░ ~25%'), model: segment('v4.1-flash'), effort: segment('high'),
    turns: segment('42 turns'), tokens: segment('166.2M tok'), cache: segment('hit 92%'), ...overrides,
  };
}

/** Flatten packed rows to their visible text. */
const text = (rows: { text: string }[][]): string => rows.map(row => row.map(segment => segment.text).join('')).join('\n');

test('the status bar drops its least valuable group first and never drops the cost', () => {
  const full = groups();
  // The golden is the widest form of both states; every narrower width is asserted below.
  const ready = groups({ state: { text: '● Ready' }, phase: undefined, stop: undefined });
  assert.equal([text(compactStatusRows(full, 140)), text(compactStatusRows(ready, 140))].join('\n') + '\n',
    readFileSync(new URL('../expected/status-compact.txt', import.meta.url), 'utf8'));
  // The ten-cell share is a fuller reading of a group the row already carries, so it appears only
  // where it displaces nothing: below its own width the plain percentage keeps its place.
  assert.match(text(compactStatusRows(full, 115)), /ctx: ███░░░░░░░ ~25%/);
  assert.equal(text(compactStatusRows(full, 114)).includes('ctx: '), false);
  // The cache-hit share restates the usage the token count already reports, so it is the first group
  // the packer gives up and it survives only while the widest row does.
  assert.match(text(compactStatusRows(full, 102)), /166\.2M tok · hit 92%/);
  assert.equal(text(compactStatusRows(full, 101)).includes('hit 92%'), false);
  assert.equal(text(compactStatusRows(full, 101)).includes('166.2M tok'), true);
  // The cost is one group for both scopes, and it is the last thing a narrow bar gives up.
  assert.match(text(compactStatusRows(full, 92)), /¥: 1\.23\(5\.00\)/);
  assert.match(text(compactStatusRows(full, 65)), /¥: 1\.23\(5\.00\)/);
  assert.equal(text(compactStatusRows(full, 37)).includes('│ ¥: '), false);
  assert.match(text(compactStatusRows(full, 37)), /^◐ 0:08 · bash 12s · \^C\n¥: 1\.23\(5\.00\)/);
  // Dropping order: cache, tokens, turns, effort, model, context — the cost stays to the last.
  assert.equal(text(compactStatusRows(full, 68)), '◐ 0:08 · bash 12s · ^C │ v4.1-flash · high · ctx 25% · ¥: 1.23(5.00)');
  assert.equal(text(compactStatusRows(full, 61)), '◐ 0:08 · bash 12s · ^C │ v4.1-flash · ctx 25% · ¥: 1.23(5.00)');
  assert.equal(text(compactStatusRows(full, 48)), '◐ 0:08 · bash 12s · ^C │ ctx 25% · ¥: 1.23(5.00)');
  assert.equal(text(compactStatusRows(full, 38)), '◐ 0:08 · bash 12s · ^C │ ¥: 1.23(5.00)');
  // Below the widest one-row form the cost opens a second row instead of being dropped.
  assert.equal(text(compactStatusRows(full, 24)), '◐ 0:08 · bash 12s · ^C\n¥: 1.23(5.00) · ctx 25%');
  // Below the width of the state cluster itself the phase and the stop hint give way first, and the
  // cost keeps its own row.
  assert.equal(text(compactStatusRows(full, 13)), '◐ 0:08\n¥: 1.23(5.00)');
  // A second row that cannot hold the cost is not opened at all, so no width renders a blank row.
  assert.equal(text(compactStatusRows(full, 12)), '◐ 0:08');
  assert.equal(text(compactStatusRows(full, 8)), '◐ 0:08');
  // Nothing overflows, at any width, including a wide-character model name.
  for (const width of [1, 10, 18, 24, 35, 40, 46, 60, 80, 100, 140]) {
    const rows = compactStatusRows(groups({ model: { text: '中文模型名称很长很长' } }), width);
    for (const row of rows) assert.ok(stringWidth(row.map(segment => segment.text).join('')) <= width, `width ${width} overflowed`);
  }
  // Remote text cannot smuggle a control character or a line break into the bar.
  assert.equal(text(compactStatusRows(groups({ model: { text: 'name\nnewline\tvalue' } }), 140)).includes('name newline value'), true);
  assert.equal(text(compactStatusRows(full, 0)), '');
});

test('the cache-hit share never rounds a partial hit up to a full one', () => {
  assert.equal(cacheHitText(0, 100), '0%');
  assert.equal(cacheHitText(300, 800), '38%');
  assert.equal(cacheHitText(996, 1_000), '99.6%');
  assert.equal(cacheHitText(9_996, 10_000), '99.96%');
  assert.equal(cacheHitText(99_999, 100_000), '99.999%');
  assert.equal(cacheHitText(1_000, 1_000), '100%');
  // A share that cannot be shown below a full hit says so instead of claiming one.
  assert.equal(cacheHitText(1_000_000 - 1, 1_000_000), '<100%');
  // Nothing to report yet, and a bucket set that claims more hits than billed input.
  assert.equal(cacheHitText(undefined, 100), undefined);
  assert.equal(cacheHitText(100, undefined), undefined);
  assert.equal(cacheHitText(0, 0), undefined);
  assert.equal(cacheHitText(5, 4), '100%');
});

test('the working clock and the phase age use the compact forms the bar shows', () => {
  assert.equal(clockText(0), '0:00');
  assert.equal(clockText(18_000), '0:18');
  assert.equal(clockText(378_000), '6:18');
  assert.equal(clockText(3_978_000), '1:06:18');
  assert.equal(clockText(-1000), '0:00');
  assert.equal(phaseText(28_000), '28s');
  assert.equal(phaseText(59_999), '59s');
  assert.equal(phaseText(68_000), '1:08');
});
