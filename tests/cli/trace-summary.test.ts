/** Reading a trace back as facts: the few questions a reader actually asks of it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTraceSummary, summarizeTrace } from '../../src/cli/trace-summary.ts';

/** One trace line, as `TraceLog` writes it. */
const line = (event: Record<string, unknown>): string => JSON.stringify({ time: '2026-09-20T10:00:00.000Z', ...event });

test('commands are counted by outcome and kind, and paired by commandId', () => {
  const summary = summarizeTrace([
    '# dsht trace: one JSON event per line, oldest first',
    line({ event: 'command', phase: 'begin', commandId: 'C1', kind: 'loop' }),
    line({ event: 'command', phase: 'end', commandId: 'C1', kind: 'loop', outcome: 'ok', disposition: 'consume' }),
    line({ event: 'command', phase: 'begin', commandId: 'C2', kind: 'error' }),
    line({ event: 'command', phase: 'end', commandId: 'C2', kind: 'error', outcome: 'rejected', disposition: 'retain', error: 'Unknown command. Use /help.' }),
    line({ event: 'command', phase: 'queued', commandId: 'C4', kind: 'compact', reason: 'turn' }),
    line({ event: 'command', phase: 'begin', commandId: 'C3', kind: 'export' }),
    line({ event: 'command', phase: 'end', commandId: 'C3', kind: 'export', outcome: 'cancelled', disposition: 'retain' }),
    line({ event: 'mutation', session: 's1', lane: 'normal', waited: false }),
    line({ event: 'mutation', session: 's1', lane: 'control', waited: true }),
    line({ event: 'mutation', session: 'v-1', lane: 'control', waited: false }),
    '{not json',
  ], '/tmp/trace.log');
  assert.equal(summary.path, '/tmp/trace.log');
  assert.equal(summary.events, 10);
  // A held line is not an executed one: only `end` (or the old phaseless form) counts.
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.commands, { total: 3, outcomes: { ok: 1, rejected: 1, cancelled: 1 }, kinds: { loop: 1, error: 1, export: 1 } });
  assert.deepEqual(summary.mutations, { total: 3, lanes: { normal: 1, control: 2 }, sessions: { s1: 2, 'v-1': 1 } });
  // Every command end had its begin, so nothing is reported as unfinished.
  assert.deepEqual(summary.anomalies, []);
  assert.equal(summary.from, '2026-09-20T10:00:00.000Z');
});

test('a span that began and never ended is reported, and never invented', () => {
  const summary = summarizeTrace([
    line({ event: 'command', phase: 'begin', commandId: 'C9', kind: 'compact' }),
    line({ event: 'command', phase: 'end', commandId: 'C9', kind: 'compact', outcome: 'ok' }),
    line({ event: 'command', phase: 'end', commandId: 'C7', kind: 'error', outcome: 'rejected' }),
  ]);
  assert.deepEqual(summary.anomalies, ['command C7 (error): end without begin']);
});

test('foreground slots report their longest run and how many were cancelled', () => {
  const summary = summarizeTrace([
    line({ event: 'foreground', phase: 'begin', id: 1, kind: 'command', label: 'Compacting history…' }),
    JSON.stringify({ time: '2026-09-20T10:00:12.400Z', event: 'foreground', phase: 'end', id: 1, kind: 'command', cancelled: false }),
    line({ event: 'foreground', phase: 'begin', id: 2, kind: 'export', label: 'Exporting session log…' }),
    line({ event: 'foreground', phase: 'end', id: 2, kind: 'export', cancelled: true }),
    line({ event: 'foreground', phase: 'begin', id: 3, kind: 'history', label: 'Loading history…' }),
  ]);
  assert.equal(summary.operations.total, 3);
  assert.equal(summary.operations.cancelled, 1);
  assert.equal(summary.operations.longestMs, 12_400);
  assert.equal(summary.operations.longest, 'Compacting history…');
  assert.equal(summary.operations.open, 1);
  assert.deepEqual(summary.anomalies, ['foreground 3: begin without end']);
});

test('loop runs and verifications are read per run, including their reason', () => {
  const summary = summarizeTrace([
    line({ event: 'loop', phase: 'command', name: 'design-review' }),
    line({ event: 'loop', phase: 'begin', runId: 'r1', kind: 'design-review' }),
    line({ event: 'loop', phase: 'sent', runId: 'r1', step: 1 }),
    line({ event: 'verify', phase: 'begin', runId: 'r1', step: 1, attempt: 1 }),
    line({ event: 'verify', phase: 'verified', runId: 'r1', score: 9 }),
    line({ event: 'loop', phase: 'sent', runId: 'r1', step: 2 }),
    line({ event: 'loop', phase: 'end', runId: 'r1', kind: 'design-review', result: 'passed', reason: 'pass' }),
    line({ event: 'loop', phase: 'begin', runId: 'r2', kind: 'designdoc-review' }),
    line({ event: 'verify', phase: 'unavailable', runId: 'r2', reason: 'verifier wrote no verdict (exit 1) · stderrClass host' }),
    line({ event: 'loop', phase: 'end', runId: 'r2', kind: 'designdoc-review', result: 'cancelled', reason: 'user-cancelled' }),
  ]);
  assert.deepEqual(summary.loops, [
    { runId: 'r1', kind: 'design-review', sent: 2, result: 'passed', reason: 'pass' },
    { runId: 'r2', kind: 'designdoc-review', sent: 0, result: 'cancelled', reason: 'user-cancelled' },
  ]);
  // One task started and finished; the other's `unavailable` has no `begin` in this window, which the
  // formatter reports as a gap rather than folding into a fake total.
  assert.deepEqual(summary.verifiers, { begin: 1, verified: 1, unavailable: 1, cancelled: 0, byClass: { host: 1 } });
  assert.deepEqual(summary.anomalies, []);
});

test('a trace written before runId and command begin/end is still readable', () => {
  const summary = summarizeTrace([
    line({ event: 'loop', phase: 'command', name: 'design-review' }),
    line({ event: 'loop', phase: 'begin', kind: 'design-review' }),
    line({ event: 'command', kind: 'panel', accepted: true }),
    line({ event: 'command', kind: 'error', accepted: false }),
  ]);
  assert.deepEqual(summary.loops, [{ runId: '', kind: 'design-review', sent: 0 }]);
  assert.deepEqual(summary.commands.outcomes, { ok: 1, rejected: 1 });
  assert.deepEqual(summary.anomalies, ['loop <no-run-id> (design-review): begin without end']);
});

test('the summary renders as plain lines a reader can scan', () => {
  const summary = summarizeTrace([
    line({ event: 'command', phase: 'end', commandId: 'C1', kind: 'loop', outcome: 'ok' }),
    line({ event: 'mutation', session: 's1', lane: 'normal' }),
    line({ event: 'foreground', phase: 'begin', id: 1, kind: 'export', label: 'Exporting…' }),
    line({ event: 'loop', phase: 'end', runId: 'r1', kind: 'design-review', result: 'passed', reason: 'pass' }),
    line({ event: 'verify', phase: 'unavailable', runId: 'r1', reason: 'stderrClass auth' }),
  ], '/tmp/trace.log');
  const lines = formatTraceSummary(summary);
  assert.equal(lines[0], 'trace · /tmp/trace.log');
  assert.match(lines[1]!, /^events 5 · 2026-09-20T10:00:00\.000Z → /u);
  assert.ok(lines.some(text => text === 'commands 1: ok 1'), lines.join('\n'));
  assert.ok(lines.some(text => text === 'session writes 1: normal 1'), lines.join('\n'));
  assert.ok(lines.some(text => text.startsWith('foreground 1: cancelled 0')), lines.join('\n'));
  assert.ok(lines.some(text => text === 'loop r1 · design-review · sent 0 → passed (pass)'), lines.join('\n'));
  assert.ok(lines.some(text => text === 'verifiers: begin 0 · verified 0 · unavailable 1 (auth 1) · cancelled 0'), lines.join('\n'));
  assert.ok(lines.some(text => text.startsWith('anomaly · foreground 1:')), lines.join('\n'));
});
