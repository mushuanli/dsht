/** Append-only diagnostic trace of connection, screen and selection transitions.
 *
 * The memory log answers "is retained content growing"; this log answers "why did the client end up
 * where it is" — every reconnect, picker and selection change is written with the values it moved
 * between, so a jump that only happens in the field can be read instead of guessed at. Events carry
 * identifiers and screen names only, never prompt, tool or session text, and a failing log stops
 * itself instead of breaking the client.
 */
import { dirname } from 'node:path';
import { appendPrivateFile, createPrivateFile, ensureDirectory, readText, writePrivateFile } from '../storage/index.ts';
import { errorText, type ObjectValue } from '../transport/wire.ts';

/** Events kept; reaching the cap rewrites the file with just these lines. */
const KEEP_EVENTS = 2000;
/** First line of the file, so a reader knows what the lines are without reading the source. */
const HEADER = '# dsht trace: one JSON event per line, oldest first\n';
/** Events whose `begin` opens a span a later phase closes; only these constrain where a cut may fall. */
const SPAN_EVENTS = new Set(['command', 'loop', 'generation']);
/** Phases that close a span opened by `begin`. */
const CLOSE_PHASES = new Set(['end', 'failed', 'cancelled', 'ended']);
/** Identifier fields, in priority order, that let a span's `begin` and its close be matched. */
const SPAN_IDS = ['commandId', 'operationId', 'turnId', 'runId', 'generationId'] as const;

/** One span marker read out of a trace line, or undefined when the line is not part of a span. */
interface Span { key: string; open: boolean }

/** Read the span one line belongs to, if any.
 *
 * A line without a known event or phase carries no span: it is an ordinary event whose position in the
 * file means nothing to a reader, so compaction may cut on either side of it. A span without its own id
 * — `generation` has none — still pairs by event name, because only one of them is ever open at a time
 * and dropping that pairing would erase the marker that separates two connections.
 * @param line - One JSON line of the trace.
 * @returns The span key and whether it opens or closes, or undefined.
 */
function spanOf(line: string): Span | undefined {
  let record: Record<string, unknown>;
  try { record = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  const event = record.event;
  const phase = record.phase;
  if (typeof event !== 'string' || !SPAN_EVENTS.has(event) || typeof phase !== 'string') return undefined;
  const open = phase === 'begin';
  if (!open && !CLOSE_PHASES.has(phase)) return undefined;
  const id = SPAN_IDS.map(field => record[field]).find(value => typeof value === 'string');
  return { key: `${event}:${id ?? ''}`, open };
}

/** The index the newest `keep` lines start at, moved forward past any split lifecycle span.
 *
 * A span opened before the cut and closed after it would be kept as a close without its begin, so the
 * cut moves to just after that close and the check repeats: the newly dropped region may itself open a
 * span that closes later. A span whose close never appears cannot be split, so it does not move the
 * cut — that is the in-flight command the file exists to show.
 * @param lines - Every line this process appended, oldest first.
 * @param keep - How many of the newest lines the caller wants to keep.
 * @returns Index of the first line to keep; always at most `lines.length - keep`.
 */
export function compactCut(lines: readonly string[], keep: number = KEEP_EVENTS): number {
  let cut = Math.max(0, lines.length - keep);
  for (;;) {
    const open = new Set<string>();
    for (let index = 0; index < cut; index += 1) {
      const span = spanOf(lines[index]!);
      if (span === undefined) continue;
      if (span.open) open.add(span.key); else open.delete(span.key);
    }
    if (open.size === 0) return cut;
    let moved = -1;
    for (let index = cut; index < lines.length; index += 1) {
      const span = spanOf(lines[index]!);
      if (span !== undefined && !span.open && open.has(span.key)) moved = index + 1;
    }
    if (moved === -1) return cut;
    cut = moved;
  }
}

/** Serialized append-only trace; the file holds at most `KEEP_EVENTS` lines, fewer when a lifecycle span would be split.
 *
 * Writes are chained rather than awaited by the caller, because transitions are published from
 * synchronous state updates. A failed write is remembered and reported on the next event instead of
 * throwing into the controller.
 */
export class TraceLog {
  private queue: Promise<void> = Promise.resolve();
  private lines: string[] = [];
  private directoryEnsured = false;
  /** Last write failure, when the log stopped growing. */
  error: string | undefined;
  constructor(readonly path: string | undefined) {}

  /** Append one event; an absent path makes this a no-op. */
  record(event: ObjectValue): void {
    if (this.path === undefined) return;
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`;
    this.lines.push(line);
    this.queue = this.queue.then(() => this.append(line))
      .catch(error => { this.error = errorText(error); });
  }

  /** Wait for queued writes, so a shutdown does not lose the last events. */
  async settle(): Promise<void> { await this.queue; }

  /** Write one line, then bound the file when the cap is reached. */
  private async append(line: string): Promise<void> {
    if (!this.directoryEnsured) { await ensureDirectory(dirname(this.path!)); this.directoryEnsured = true; }
    // Seeding a header only affects a new file; an existing trace is appended to.
    await createPrivateFile(this.path!, HEADER);
    await appendPrivateFile(this.path!, line);
    this.error = undefined;
    if (this.lines.length >= KEEP_EVENTS) await this.compact();
  }

  /** Rewrite the file with the header and the newest kept lines, bounding its size.
   *
   * Older runs are not read back: `lines` is what this process appended, which bounds both the file
   * and the read that rewrites it. The cut is pairing-aware, so a kept `begin` is never orphaned from
   * its close and a kept close never loses its begin.
   */
  private async compact(): Promise<void> {
    const kept = this.lines.slice(compactCut(this.lines, KEEP_EVENTS));
    await writePrivateFile(this.path!, HEADER + kept.join(''));
    this.lines = kept;
  }
}

/** Read a trace back, so a test or a diagnostic tool can assert what was recorded.
 * @param path - Trace file to read.
 * @returns Every non-empty line, oldest first.
 */
export async function readTrace(path: string): Promise<string[]> {
  const text = await readText(path);
  return text === undefined ? [] : text.split('\n').filter(line => line !== '');
}
