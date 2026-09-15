/** Local `!` blocks as transcript rows: a highlighted command bar, then its indented output.
 *
 * A block is spliced into the conversation where it happened — after the newest record the session
 * had when the command started — so it scrolls away like any message instead of sitting pinned to
 * the bottom of the screen.
 */
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { HistoryRow, RowKind } from '../../contracts.ts';
import type { ShellBlock } from '../../contracts.ts';

/** First output row's marker, so a block reads as the command's result. */
const MARKER = '  ⎿  ';
/** Rows after the first, aligned under the marker. */
const GUTTER = '   ';

/** The part of a transcript layout this module needs to place a block. */
export interface RowSource {
  /** Number of host rows, live tail included. */
  length: number;
  /** Host rows in a range. */
  viewport(start: number, end: number): HistoryRow[];
  /** Projected messages in ascending sequence order. */
  messages: readonly { seq: number }[];
  /** Row index where each visible message starts. */
  offsets: ReadonlyMap<number, number>;
}

/** One block's rows and the host row index they follow. */
interface Placement { at: number; rows: HistoryRow[] }

/** Rows for one run: the command bar, then its wrapped and indented output.
 * @param run - Block from the shell controller.
 * @param width - Available terminal columns.
 * @returns Rows in display order.
 */
export function blockRows(run: ShellBlock, width: number): HistoryRow[] {
  const reserve = Math.max(stringWidth(MARKER), stringWidth(GUTTER));
  const rows: HistoryRow[] = [{ text: `! ${run.command}`, kind: 'shell', bold: true, highlight: true }];
  const body = [
    ...(run.dropped > 0 ? [`… ${run.dropped} earlier lines dropped …`] : []),
    ...run.lines,
  ];
  if (!body.length) body.push(run.status === 'running' ? 'running…' : '(no output)');
  body.forEach((line, index) => {
    const wrapped = plainRows(line, Math.max(8, width - reserve), 'shell');
    wrapped.forEach((row, position) => {
      rows.push({ ...row, text: `${index === 0 && position === 0 ? MARKER : GUTTER}${row.text}` });
    });
  });
  if (run.status === 'exited' && (run.signal != null || (run.code ?? 0) !== 0)) {
    rows.push({ text: `${GUTTER}exit ${run.signal ?? run.code}`, kind: 'muted' });
  }
  return rows;
}

/** Host row index where a block anchored at `anchor` belongs.
 *
 * It goes after every row of the newest message it followed, which is the start of the next message,
 * or the end of the layout when nothing newer is loaded.
 * @param layout - Transcript layout to place into.
 * @param anchor - Durable sequence the command followed.
 * @returns Host row index.
 */
function rowAfter(layout: RowSource, anchor: number): number {
  let low = 0, high = layout.messages.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (layout.messages[mid]!.seq <= anchor) low = mid + 1; else high = mid;
  }
  if (low >= layout.messages.length) return layout.length;
  return layout.offsets.get(layout.messages[low]!.seq) ?? layout.length;
}

/** Splice every retained block into a transcript layout.
 *
 * Equal anchors keep creation order, and an anchor older than a block already placed is clamped to
 * it, so the merged stream stays ordered even as history is paged in behind the reader.
 * @param layout - Transcript layout to merge with.
 * @param runs - Blocks from the shell controller, oldest first.
 * @param width - Available terminal columns.
 * @returns The merged row count and a reader over a merged range.
 */
export function mergeShellRuns(layout: RowSource, runs: readonly ShellBlock[], width: number): {
  total: number;
  viewport(start: number, end: number): HistoryRow[];
} {
  const placements: Placement[] = [];
  let cursor = 0;
  for (const run of runs) {
    const at = Math.max(cursor, Math.min(layout.length, rowAfter(layout, run.anchor)));
    placements.push({ at, rows: blockRows(run, width) });
    cursor = at;
  }
  // Segments alternate host rows and block rows in merged index order.
  const segments: { from: number; count: number; host?: number; rows?: HistoryRow[] }[] = [];
  let merged = 0, host = 0;
  for (const placement of placements) {
    if (placement.at > host) {
      segments.push({ from: merged, count: placement.at - host, host });
      merged += placement.at - host; host = placement.at;
    }
    segments.push({ from: merged, count: placement.rows.length, rows: placement.rows });
    merged += placement.rows.length;
  }
  if (host < layout.length) segments.push({ from: merged, count: layout.length - host, host });
  const total = merged + Math.max(0, layout.length - host);
  return {
    total,
    viewport(start, end) {
      const rows: HistoryRow[] = [];
      for (const segment of segments) {
        const segmentStart = segment.from, segmentEnd = segment.from + segment.count;
        if (segmentEnd <= start || segmentStart >= end) continue;
        const from = Math.max(0, start - segmentStart);
        const to = Math.min(segment.count, end - segmentStart);
        if (to <= from) continue;
        if (segment.rows) rows.push(...segment.rows.slice(from, to));
        else rows.push(...layout.viewport(segment.host! + from, segment.host! + to));
      }
      return rows;
    },
  };
}

/** Wrap plain local text into terminal rows, preserving its own whitespace.
 *
 * Command output is aligned by spaces and indented by stack traces, so this never collapses runs of
 * whitespace the way tool summaries do; only the terminal width decides where a row breaks.
 * @param text - Raw text, possibly containing newlines.
 * @param width - Available terminal columns.
 * @param kind - Row kind used for coloring.
 * @param highlight - Whether the rows are a local command line drawn on the command bar.
 * @returns One row per wrapped terminal line; empty text yields one empty row.
 */
export function plainRows(text: string, width: number, kind: RowKind, highlight = false): HistoryRow[] {
  const columns = Math.max(1, width);
  const wrapped = wrapAnsi(text === '' ? ' ' : text, columns, { hard: true, trim: false });
  return wrapped.split('\n').map(line => ({ text: line, kind, ...(highlight ? { highlight: true } : {}) }));
}
