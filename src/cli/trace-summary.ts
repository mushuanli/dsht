/** Reading a trace back as a few lines: what ran, what was refused, and what never finished.
 *
 * The trace is written for a machine (`slash.md` §7) and a reader only ever asks a handful of
 * questions of it: which commands ran and how they ended, which session writes were serialized, what
 * owned the client and for how long, how the loops and verifications went, and whether any span is
 * still open. This module answers exactly those, from the lines alone, so it can be tested without a
 * file and reused by a future `--json` consumer.
 *
 * It never re-derives a fact the trace did not record: an event it does not know is counted as
 * skipped rather than guessed at.
 */

/** One loop run as the trace describes it. */
export interface TraceLoopRun {
  readonly runId: string;
  readonly kind: string;
  /** Steps the run sent, counted from its `sent` events. */
  readonly sent: number;
  /** Phase the run ended in, when it reached one. */
  readonly result?: string;
  /** Why it ended, when the end recorded a reason. */
  readonly reason?: string;
}

/** Everything `dsht trace` reports about one trace file. */
export interface TraceSummary {
  readonly path: string;
  /** Events read, and lines that were not events (unparsable or foreign). */
  readonly events: number;
  readonly skipped: number;
  /** First and last event timestamps, when the trace has any. */
  readonly from?: string;
  readonly to?: string;
  /** Submissions: how they ended and which command kinds they were. */
  readonly commands: { readonly total: number; readonly outcomes: Record<string, number>; readonly kinds: Record<string, number> };
  /** Session writes: total, by lane and by target session. */
  readonly mutations: { readonly total: number; readonly lanes: Record<string, number>; readonly sessions: Record<string, number> };
  /** Foreground slots: total, cancelled, the longest one, and any left open. */
  readonly operations: { readonly total: number; readonly cancelled: number; readonly longestMs?: number; readonly longest?: string; readonly open: number };
  readonly loops: readonly TraceLoopRun[];
  /** Verification tasks: how many started, and how they concluded.
   *
   * `begin` is not derivable from the outcomes — a task whose process died mid-flight has neither —
   * so both are reported and the formatter points out the gap.
   */
  readonly verifiers: { readonly begin: number; readonly verified: number; readonly unavailable: number; readonly cancelled: number; readonly byClass: Record<string, number> };
  /** Spans that began and never ended, oldest first. */
  readonly anomalies: readonly string[];
}

/** Count one key in a tally. */
function count(tally: Record<string, number>, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1;
}

/** Name one loop run in a report; a pre-`runId` trace has no identity to show. */
function label(runId: string): string { return runId === '' ? '<no-run-id>' : runId; }

/** Read the identifier a span pairs on, or undefined when the event carries none. */
function spanId(record: Record<string, unknown>): string | undefined {
  for (const field of ['commandId', 'id', 'runId']) {
    const value = record[field];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

/** Summarize one trace file's lines.
 * @param lines - Raw trace lines, oldest first, header and blanks included.
 * @param path - File the lines came from, for the report.
 * @returns The summary a reader wants.
 */
export function summarizeTrace(lines: readonly string[], path = ''): TraceSummary {
  const outcomes: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  const lanes: Record<string, number> = {};
  const sessions: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  const runs = new Map<string, { kind: string; sent: number; result?: string; reason?: string }>();
  const openCommands = new Map<string, string>();
  const openOperations = new Map<string, { label: string; startedAt: number }>();
  const openLoops = new Map<string, string>();
  const orphans: string[] = [];
  const anomalies: string[] = [];
  let events = 0;
  let skipped = 0;
  let from: string | undefined;
  let to: string | undefined;
  let commandEnds = 0;
  let operations = 0;
  let cancelled = 0;
  let longestMs: number | undefined;
  let longest: string | undefined;
  let verifierBegins = 0;
  let verified = 0;
  let unavailable = 0;
  let verifierCancelled = 0;

  for (const line of lines) {
    if (line === '' || line.startsWith('#')) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { skipped++; continue; }
    if (typeof record.event !== 'string') { skipped++; continue; }
    events++;
    const time = typeof record.time === 'string' ? record.time : undefined;
    if (time !== undefined) { from ??= time; to = time; }
    const id = spanId(record);
    switch (record.event) {
      case 'command': {
        if (record.phase === 'begin') { if (id !== undefined) openCommands.set(id, String(record.kind ?? 'unknown')); break; }
        // A held line was accepted but not run; only a `begin`/`end` pair is an execution.
        if (record.phase === 'queued') break;
        commandEnds++;
        const paired = id !== undefined && openCommands.delete(id);
        // A trace written before `command begin/end` has one phaseless event per line, whose fate is
        // the old `accepted` flag; reading it as an end keeps an existing file useful, and a phaseless
        // line is never reported as an orphan end.
        if (record.phase === 'end' && id !== undefined && !paired) {
          orphans.push(`command ${id} (${String(record.kind ?? 'unknown')}): end without begin`);
        }
        const outcome = typeof record.outcome === 'string' ? record.outcome : record.accepted === true ? 'ok' : 'rejected';
        count(outcomes, outcome);
        count(kinds, String(record.kind ?? 'unknown'));
        break;
      }
      case 'mutation':
        count(lanes, String(record.lane ?? 'unknown'));
        count(sessions, String(record.session ?? 'unknown'));
        break;
      case 'foreground': {
        if (record.phase === 'begin') {
          operations++;
          if (id !== undefined) openOperations.set(id, { label: String(record.label ?? record.kind ?? ''), startedAt: time === undefined ? 0 : Date.parse(time) });
          break;
        }
        if (id === undefined) break;
        const started = openOperations.get(id);
        openOperations.delete(id);
        if (started === undefined) orphans.push(`foreground ${id}: end without begin`);
        if (record.cancelled === true) cancelled++;
        if (started !== undefined && time !== undefined) {
          const ms = Date.parse(time) - started.startedAt;
          if (Number.isFinite(ms) && (longestMs === undefined || ms > longestMs)) { longestMs = ms; longest = started.label; }
        }
        break;
      }
      case 'loop': {
        // Events that describe a submission rather than a run (`command`, `form`, `rejected`) are not
        // a run and must not invent one. A trace written before `runId` existed has one key for the
        // run events it did record; they still pair, they just cannot be told apart per run.
        const runId = typeof record.runId === 'string' ? record.runId : undefined;
        const describesRun = runId !== undefined || record.phase === 'begin' || record.phase === 'sent' || record.phase === 'end';
        if (!describesRun) break;
        const key = runId ?? '';
        const run = runs.get(key) ?? { kind: 'unknown', sent: 0 };
        if (typeof record.kind === 'string') run.kind = record.kind;
        if (record.phase === 'begin') openLoops.set(key, run.kind);
        if (record.phase === 'sent') run.sent++;
        if (record.phase === 'end') {
          if (!openLoops.delete(key)) orphans.push(`loop ${label(key)} (${run.kind}): end without begin`);
          run.result = String(record.result ?? 'unknown');
          if (record.reason !== undefined) run.reason = String(record.reason);
        }
        runs.set(key, run);
        break;
      }
      case 'verify': {
        if (record.phase === 'begin') { verifierBegins++; break; }
        if (record.phase === 'verified') { verified++; break; }
        if (record.phase === 'cancelled' || record.phase === 'abandoned') { verifierCancelled++; break; }
        if (record.phase === 'unavailable') {
          unavailable++;
          const match = /stderrClass (\w+)/.exec(String(record.reason ?? ''));
          if (match?.[1] !== undefined) count(byClass, match[1]);
        }
        break;
      }
      default: break;
    }
  }

  for (const [id, kind] of openCommands) anomalies.push(`command ${id} (${kind}): begin without end`);
  for (const id of openOperations.keys()) anomalies.push(`foreground ${id}: begin without end`);
  for (const [runId, kind] of openLoops) anomalies.push(`loop ${label(runId)} (${kind}): begin without end`);
  // An end whose begin is missing means the window dropped it or the writer is broken; either way the
  // reader has to see it, because the pairing is what makes the rest of the file trustworthy.
  anomalies.push(...orphans);

  return {
    path, events, skipped,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    commands: { total: commandEnds, outcomes, kinds },
    mutations: { total: Object.values(lanes).reduce((sum, value) => sum + value, 0), lanes, sessions },
    operations: { total: operations, cancelled, ...(longestMs === undefined ? {} : { longestMs, longest }), open: openOperations.size },
    loops: [...runs.entries()].map(([runId, run]) => ({ runId, ...run })),
    verifiers: { begin: verifierBegins, verified, unavailable, cancelled: verifierCancelled, byClass },
    anomalies,
  };
}

/** Render one tally as `key value · key value`, widest count first. */
function tally(text: Record<string, number>): string {
  return Object.entries(text).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key} ${value}`).join(' · ');
}

/** Render a summary as the lines `dsht trace` prints.
 * @param summary - Result of `summarizeTrace`.
 * @returns Plain lines, one fact per line, without a trailing newline.
 */
export function formatTraceSummary(summary: TraceSummary): string[] {
  const lines: string[] = [`trace · ${summary.path}`, `events ${summary.events}${summary.skipped === 0 ? '' : ` (+${summary.skipped} unreadable)`}`
    + `${summary.from === undefined ? '' : ` · ${summary.from} → ${summary.to}`}`];
  if (summary.commands.total > 0) {
    lines.push(`commands ${summary.commands.total}: ${tally(summary.commands.outcomes)}`);
    lines.push(`  kinds: ${tally(summary.commands.kinds)}`);
  }
  if (summary.mutations.total > 0) {
    lines.push(`session writes ${summary.mutations.total}: ${tally(summary.mutations.lanes)}`);
    lines.push(`  by session: ${tally(summary.mutations.sessions)}`);
  }
  const { longestMs, longest } = summary.operations;
  if (summary.operations.total > 0) {
    const slowest = longestMs === undefined ? '' : ` · longest ${(longestMs / 1000).toFixed(1)}s (${longest})`;
    lines.push(`foreground ${summary.operations.total}: cancelled ${summary.operations.cancelled}${slowest}`);
  }
  for (const run of summary.loops) {
    const end = run.result === undefined ? 'unfinished' : `${run.result}${run.reason === undefined ? '' : ` (${run.reason})`}`;
    lines.push(`loop ${label(run.runId)} · ${run.kind} · sent ${run.sent} → ${end}`);
  }
  const { begin, verified, unavailable, cancelled: verifierCancelled, byClass } = summary.verifiers;
  if (begin > 0 || verified + unavailable + verifierCancelled > 0) {
    const classes = Object.keys(byClass).length === 0 ? '' : ` (${tally(byClass)})`;
    const concluded = verified + unavailable + verifierCancelled;
    lines.push(`verifiers: begin ${begin} · verified ${verified} · unavailable ${unavailable}${classes}`
      + ` · cancelled ${verifierCancelled}`
      + (begin > concluded ? ` · ${begin - concluded} without a conclusion` : ''));
  }
  for (const anomaly of summary.anomalies) lines.push(`anomaly · ${anomaly}`);
  return lines;
}
