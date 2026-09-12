/** Multi-row composer geometry: wrapping, tab stops, block folding and the cursor window.
 *
 * The draft keeps exactly the bytes the user typed or pasted; nothing here mutates it. Display rows
 * and folded blocks are derived on every render, so an edit never has to rebase a stored span.
 */
import stringWidth from 'string-width';

/** Cells a tab advances to; every stop is a multiple of this width. */
export const TAB_WIDTH = 4;

/** Source range of one block that renders as a summary row instead of its text. */
export interface FoldRegion { start: number; end: number }

/** One rendered draft row and the source range it came from. */
export interface DraftRow {
  /** Display text; tabs are already expanded to spaces. */
  text: string;
  /** First source offset covered by this row. */
  start: number;
  /** One past the last source offset covered by this row. */
  end: number;
  /** `map[k]` is the index in `text` of source offset `start + k`. */
  map: number[];
  /** Present when this row summarizes a folded block rather than showing its text. */
  fold?: { from: number; to: number; lines: number; bytes: number };
}

/** Where the cursor lands among the rendered rows. */
export interface CursorPlace { row: number; index: number; column: number }

/** Rendered rows plus the blocks the editor must treat as single objects. */
export interface DraftPlan { rows: DraftRow[]; regions: FoldRegion[] }

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Spaces a tab adds to reach the next stop after the given column.
 * @param column - Cells already used on the row.
 * @param width - Tab stop width in cells.
 * @returns Cell count for one tab, always at least one.
 */
export function tabStop(column: number, width = TAB_WIDTH): number { return width - (column % width); }

/** Byte length of draft text, used for the folded-block size label.
 * @param text - Source text.
 * @returns UTF-8 byte length.
 */
export function byteLength(text: string): number { return Buffer.byteLength(text, 'utf8'); }

/** Compact size label for a folded block.
 * @param bytes - UTF-8 byte length.
 * @returns Bytes, kilobytes or megabytes with one decimal.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Offsets where each newline-separated line begins.
 * @param text - Source text.
 * @returns One offset per logical line, always at least the offset zero.
 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length;) {
    const next = text.indexOf('\n', index);
    if (next === -1) break;
    starts.push(next + 1); index = next + 1;
  }
  return starts;
}

/** Wrap a draft into display rows, expanding tabs and hard-breaking long segments.
 *
 * A newline belongs to the end of the row it closes, so a cursor parked on it renders at that row's
 * end and a cursor just after it renders at the next row's start.
 * @param text - Source text, including newlines and tabs.
 * @param width - Row width in cells.
 * @param tabWidth - Tab stop width in cells.
 * @returns One entry per rendered row, in order.
 */
export function wrapDraft(text: string, width: number, tabWidth = TAB_WIDTH): DraftRow[] {
  const limit = Math.max(1, Math.floor(width));
  const rows: DraftRow[] = [];
  let row: DraftRow = { text: '', start: 0, end: 0, map: [0] };
  let column = 0;
  let offset = 0;
  const close = (end: number) => { row.end = end; rows.push(row); };
  const open = (start: number) => { row = { text: '', start, end: start, map: [0] }; column = 0; };
  for (const { segment } of segments.segment(text)) {
    const length = segment.length;
    if (segment === '\n') {
      row.map.push(row.text.length);
      close(offset + length);
      open(offset + length);
      offset += length;
      continue;
    }
    const display = segment === '\t' ? ' '.repeat(tabStop(column, tabWidth)) : segment;
    const cells = segment === '\t' ? display.length : stringWidth(segment);
    if (column > 0 && column + cells > limit) { close(offset); open(offset); }
    row.text += display;
    column += cells;
    offset += length;
    row.map.push(row.text.length);
  }
  close(offset);
  return rows;
}

/** Locate the cursor among rendered rows.
 * @param rows - Rendered rows from `wrapDraft`.
 * @param cursor - Source offset of the cursor.
 * @returns Row index, display index within that row, and its cell column.
 */
export function cursorPlace(rows: readonly DraftRow[], cursor: number): CursorPlace {
  for (let row = 0; row < rows.length; row++) {
    const current = rows[row]!;
    if (cursor >= current.start && cursor < current.end) {
      const index = current.map[cursor - current.start] ?? current.text.length;
      return { row, index, column: stringWidth(current.text.slice(0, index)) };
    }
  }
  const row = rows.length - 1;
  const last = rows[row]!;
  return { row, index: last.text.length, column: stringWidth(last.text) };
}

/** Choose the visible slice of rows that keeps the cursor on screen.
 * @param count - Total rendered row count.
 * @param cursorRow - Row index the cursor occupies.
 * @param maxRows - Content rows the composer may show.
 * @returns Half-open row range to render.
 */
export function windowRows(count: number, cursorRow: number, maxRows: number): { start: number; end: number } {
  const size = Math.max(1, Math.floor(maxRows));
  if (count <= size) return { start: 0, end: count };
  const start = Math.min(Math.max(0, cursorRow - size + 1), count - size);
  return { start, end: start + size };
}

/** Shift a wrapped slice back to the source offsets it was cut from.
 * @param rows - Rows wrapped from a slice.
 * @param base - Source offset the slice started at.
 * @returns The same rows with absolute offsets.
 */
function rebase(rows: DraftRow[], base: number): DraftRow[] {
  return base === 0 ? rows : rows.map(row => ({ ...row, start: row.start + base, end: row.end + base }));
}

/** Summary row for a folded interior.
 * @param text - Whole draft.
 * @param starts - Logical line starts.
 * @param from - First folded source offset.
 * @param to - One past the last folded source offset.
 * @returns The row that replaces the interior.
 */
function summary(text: string, starts: readonly number[], from: number, to: number): DraftRow {
  return { text: '', start: from, end: to, map: [],
    fold: { from, to, lines: starts.length - 2, bytes: byteLength(text.slice(from, to)) } };
}

/** Wrap and fold a draft for display.
 *
 * A block is folded only when the draft has interior lines to hide and its whole wrapped height
 * exceeds the composer window. The decision reads the unfolded height, so folding can never feed
 * back into itself and oscillate. When the logical line count alone already exceeds the window the
 * interior is never wrapped, which keeps a very large paste cheap to re-plan on every keystroke.
 * @param text - Source text, including newlines and tabs.
 * @param width - Row width in cells.
 * @param maxRows - Content rows the composer may show.
 * @param tabWidth - Tab stop width in cells.
 * @returns Rows to render and the source range of every folded block.
 */
export function planDraft(text: string, width: number, maxRows: number, tabWidth = TAB_WIDTH): DraftPlan {
  const starts = lineStarts(text);
  const size = Math.max(1, Math.floor(maxRows));
  if (starts.length >= 3 && starts.length > size) {
    const from = starts[1]!;
    const to = starts[starts.length - 1]!;
    // The head slice ends with the newline that closes its last line, so the empty row that
    // newline opens belongs to the block being folded, not to the head.
    const head = wrapDraft(text.slice(0, from), width, tabWidth);
    head.pop();
    return { rows: [...head, summary(text, starts, from, to),
      ...rebase(wrapDraft(text.slice(to), width, tabWidth), to)], regions: [{ start: from, end: to }] };
  }
  const rows = wrapDraft(text, width, tabWidth);
  if (starts.length < 3 || rows.length <= size) return { rows, regions: [] };
  const from = starts[1]!;
  const to = starts[starts.length - 1]!;
  return { rows: [...rows.filter(row => row.start < from), summary(text, starts, from, to), ...rows.filter(row => row.start >= to)],
    regions: [{ start: from, end: to }] };
}

/** Display label for a folded block.
 * @param fold - Folded-block facts.
 * @returns A single-line summary such as `[84 lines · 6.1 KB]`.
 */
export function foldLabel(fold: NonNullable<DraftRow['fold']>): string {
  return `[${fold.lines} lines · ${formatBytes(fold.bytes)}]`;
}
