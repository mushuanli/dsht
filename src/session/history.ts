/** Indexed semantic history with bounded terminal-row caching and viewport-only materialization. */
import wrapAnsi from 'wrap-ansi';
import { toolLine, type Message, type MessagePart, type Transcript } from './transcript.ts';
import { hasMarkdown, markdownRows, type MarkdownSpan } from './markdown.ts';

/** Default fold mode; individual sequence overrides are view state, never stored content. */
export type Reasoning = 'row' | 'full';
/** Color semantics are independent of the selected terminal palette. */
export type RowKind = MessagePart['kind'] | 'user' | 'assistant' | 'context' | 'muted';
/** One visible terminal row; no remote ANSI is allowed into its text. */
export interface HistoryRow { text: string; kind: RowKind; bold?: boolean; seq?: number; spans?: MarkdownSpan[] }
interface Segment { message: Message; start: number; count: number; reasoning: Reasoning; heading: boolean; assistantSeen: boolean }
interface CachedRows { width: number; reasoning: Reasoning; heading: boolean; rows: HistoryRow[] }

/** A session owns one layout cache; dropped sessions release their entire cache. */
class LayoutIndex {
  messages: Message[] = [];
  segments: Segment[] = [];
  offsets = new Map<number, number>();
  length = 0;
  private cache = new Map<Message, CachedRows>();
  private cacheSize = 0;
  // Bound both row objects and long rows. Full semantic content remains available for search.
  private readonly maxRows = 2048;
  private heights = new WeakMap<Message, { width: number; reasoning: Reasoning; heading: boolean; count: number }>();
  /** Incremental wrapping state for the growing live tail, keyed by each live part's identity. */
  readonly liveWraps = new Map<string, LiveWrap>();
  readonly liveMarkdown = new Map<string, { length: number; rich: boolean }>();
  constructor(readonly width: number, readonly reasoning: Reasoning, readonly overrides: ReadonlySet<number>) {}

  rows(message: Message, reasoning: Reasoning, heading: boolean): HistoryRow[] {
    const cached = this.cache.get(message);
    if (cached?.width === this.width && cached.reasoning === reasoning && cached.heading === heading) {
      this.cache.delete(message); this.cache.set(message, cached);
      return cached.rows;
    }
    const rows = messageRows(message, this.width, reasoning, heading);
    if (cached) { this.cache.delete(message); this.cacheSize -= cached.rows.length; }
    if (rows.length <= this.maxRows && rows.reduce((sum, row) => sum + row.text.length, 0) <= 256 * 1024) {
      while (this.cacheSize + rows.length > this.maxRows) {
        const key = this.cache.keys().next().value!;
        this.cacheSize -= this.cache.get(key)!.rows.length; this.cache.delete(key);
      }
      this.cache.set(message, { width: this.width, reasoning, heading, rows }); this.cacheSize += rows.length;
    }
    return rows;
  }

  dispose(): void {
    this.messages = []; this.segments = []; this.offsets.clear();
    this.cache.clear(); this.cacheSize = 0; this.length = 0; this.heights = new WeakMap();
    this.liveWraps.clear();
    this.liveMarkdown.clear();
  }

  get cachedRowCount(): number { return this.cacheSize; }

  /** Measure what the row cache actually holds, including the style spans the byte bound ignores.
   * @returns Cached rows, their accounted characters, and the span objects inside them.
   */
  stats(): { rows: number; cacheBytes: number; spans: number; spanChars: number } {
    let cacheBytes = 0, spans = 0, spanChars = 0;
    for (const { rows } of this.cache.values()) {
      for (const row of rows) {
        cacheBytes += row.text.length;
        for (const span of row.spans ?? []) { spans++; spanChars += span.text.length; }
      }
    }
    return { rows: this.cacheSize, cacheBytes, spans, spanChars };
  }

  get assistantSeen(): boolean { return this.segments.at(-1)?.assistantSeen ?? false; }

  update(messages: Message[]): void {
    if (messages === this.messages) return;
    // Appended durable messages extend the row index; replacements and older pages rebuild offsets.
    let prefix = 0;
    while (prefix < this.messages.length && prefix < messages.length && this.messages[prefix] === messages[prefix]) prefix++;
    if (prefix < this.messages.length) {
      const retained = new Set(messages);
      for (const [message, cached] of this.cache) if (!retained.has(message)) {
        this.cacheSize -= cached.rows.length; this.cache.delete(message);
      }
      this.segments.length = prefix;
      this.offsets = new Map(this.segments.map(segment => [segment.message.seq, segment.start]));
      this.length = this.segments.at(-1) ? this.segments.at(-1)!.start + this.segments.at(-1)!.count : 0;
    }
    let assistantSeen = this.assistantSeen;
    for (let i = prefix; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role === 'You') assistantSeen = false;
      const heading = !message.compact && (message.role !== 'Assistant' || !assistantSeen);
      if (message.role === 'Assistant' && heading) assistantSeen = true;
      const reasoning = this.overrides.has(message.seq) ? this.reasoning === 'row' ? 'full' : 'row' : this.reasoning;
      const cached = this.heights.get(message);
      const count = cached?.width === this.width && cached.reasoning === reasoning && cached.heading === heading ? cached.count : this.rows(message, reasoning, heading).length;
      this.heights.set(message, { width: this.width, reasoning, heading, count });
      this.offsets.set(message.seq, this.length);
      this.segments.push({ message, start: this.length, count, reasoning, heading, assistantSeen }); this.length += count;
    }
    this.messages = messages;
  }

  viewport(start: number, end: number): HistoryRow[] {
    let lo = 0, hi = this.segments.length;
    while (lo < hi) {
      const middle = (lo + hi) >>> 1;
      const segment = this.segments[middle]!;
      if (segment.start + segment.count <= start) lo = middle + 1;
      else hi = middle;
    }
    const rows: HistoryRow[] = [];
    for (let i = lo; i < this.segments.length; i++) {
      const segment = this.segments[i]!;
      if (segment.start >= end) break;
      rows.push(...this.rows(segment.message, segment.reasoning, segment.heading).slice(Math.max(0, start - segment.start), end - segment.start));
    }
    return rows;
  }
}

const liveRows = new WeakMap<MessagePart, { width: number; reasoning: Reasoning; rows: HistoryRow[] }>();

/** Incremental wrap state for one growing live part. */
interface LiveWrap {
  width: number;
  reasoning: Reasoning;
  kind: MessagePart['kind'];
  /** Source length already folded into `rows` and `carry`. */
  length: number;
  /** Rows whose text can no longer change as more arrives. */
  rows: HistoryRow[];
  /** Raw source of the one row that can still change. */
  carry: string;
}

/** Wrap text into rows with the per-kind trimming rule.
 * @param text - Text to wrap.
 * @param width - Available terminal columns.
 * @param kind - Part kind, which decides whether wrapped lines are trimmed.
 * @param seq - Durable sequence, for committed parts.
 * @returns The wrapped rows.
 */
function wrapRows(text: string, width: number, kind: MessagePart['kind'], seq?: number): HistoryRow[] {
  return wrapAnsi(text, width, { hard: true, trim: !['tool', 'success', 'error'].includes(kind) })
    .split('\n').map(text => ({ text, kind, seq }));
}

/** Bound the source inspected for a folded row, which renders only the first `width` columns.
 * @param text - Complete live text.
 * @param width - Available terminal columns.
 * @returns A prefix that cannot change the folded row.
 */
function foldedSource(text: string, width: number): string {
  let limit = width * 4 + 64;
  while (limit < text.length && toolLine(text.slice(0, limit), width).length < width) limit *= 2;
  return limit >= text.length ? text : text.slice(0, limit);
}

/** Locate the start of one rendered row inside the source it was wrapped from.
 *
 * Trim removes the whitespace runs at both ends of a row, so a rendered row is not a contiguous
 * slice; matching it backwards while skipping source whitespace recovers where it began. The scan
 * gives up once it would have to skip more than `limit` characters, which sends the caller back to
 * a whole-text wrap instead of scanning an unbounded whitespace run.
 * @param pending - Source text the row was wrapped from.
 * @param row - One rendered row from that wrap.
 * @param limit - Maximum characters the backward scan may skip.
 * @returns The row's start offset, or undefined when it cannot be located.
 */
function rawStart(pending: string, row: string, limit: number): number | undefined {
  let source = pending.length - 1;
  let target = row.length - 1;
  const floor = pending.length - limit;
  while (target >= 0 && source >= floor) {
    if (pending[source] === row[target]) { source--; target--; continue; }
    if (/\s/u.test(pending[source]!)) { source--; continue; }
    return undefined;
  }
  return target < 0 ? source + 1 : undefined;
}

/** Wrap one live part incrementally, re-wrapping only rows that can still change plus the new delta.
 *
 * A streaming part only grows, so every row before its last non-empty one is final. The state keeps
 * those rows plus the raw source of the unfinished remainder, and re-anchors from the whole text
 * only when that remainder cannot be located or outgrows a few widths.
 * @param part - One live part carrying a stable `key`.
 * @param state - Per-layout state keyed by that identity.
 * @param width - Available terminal columns.
 * @param reasoning - Fold mode for completed live reasoning.
 * @returns The part's rows.
 */
function livePartRows(part: MessagePart, state: Map<string, LiveWrap>, width: number, reasoning: Reasoning): HistoryRow[] {
  const key = part.key;
  if (key === undefined) return partRows([part], width, reasoning);
  if (part.kind === 'reasoning' && reasoning === 'row' && (part.closed || width < 60)) {
    state.delete(key);
    return wrapRows(toolLine(`◇ /think live · ${foldedSource(part.text, width).slice(2)}`, width), width, 'reasoning');
  }
  const previous = state.get(key);
  const extend = previous !== undefined && previous.width === width && previous.reasoning === reasoning
    && previous.kind === part.kind && part.text.length >= previous.length;
  const trim = !['tool', 'success', 'error'].includes(part.kind);
  const limit = width * 8 + 512;
  const attempt = (source: string, prior: HistoryRow[]): { rows: HistoryRow[]; tail: string[]; carry: string } | undefined => {
    const wrapped = wrapAnsi(source, width, { hard: true, trim }).split('\n');
    const filled = wrapped.reduce((found, text, index) => text === '' ? found : index, -1);
    if (filled < 0) return { rows: [], tail: wrapped, carry: source };
    const start = rawStart(source, wrapped[filled]!, limit);
    if (start === undefined) return undefined;
    return {
      rows: [...prior, ...wrapped.slice(0, filled).map(text => ({ text, kind: part.kind }))],
      tail: wrapped.slice(filled),
      // The last non-empty row and everything after it, including trailing empty rows, stay unfinished.
      carry: source.slice(start),
    };
  };
  let result = attempt(extend ? previous.carry + part.text.slice(previous.length) : part.text, extend ? previous.rows : []);
  if (result === undefined || result.carry.length > width * 4 + 64) result = attempt(part.text, []);
  // Recovery can fail on text whose last row cannot be located; the plain one-shot wrap is the fallback.
  if (result === undefined) { state.delete(key); return partRows([part], width, reasoning); }
  const rows = [...result.rows, ...result.tail.map(text => ({ text, kind: part.kind }))];
  state.set(key, { width, reasoning, kind: part.kind, length: part.text.length, rows: result.rows, carry: result.carry });
  return rows;
}

function partRows(parts: MessagePart[], width: number, reasoning: Reasoning, seq?: number): HistoryRow[] {
  return parts.flatMap(part => {
    const cached = seq === undefined ? liveRows.get(part) : undefined;
    if (cached?.width === width && cached.reasoning === reasoning) return cached.rows;
    const fold = part.kind === 'reasoning' && reasoning === 'row' && (seq !== undefined || part.closed || width < 60);
    const text = fold ? toolLine(`◇ /think${seq === undefined ? ' live' : ` ${seq}`} · ${part.text.slice(2)}`, width) : part.text;
    const rows = part.kind === 'text' ? markdownRows(text, width).map(row => ({ ...row, kind: part.kind, seq }))
      : wrapRows(text, width, part.kind, seq);
    if (seq === undefined) liveRows.set(part, { width, reasoning, rows });
    return rows;
  });
}

function messageRows(message: Message, width: number, reasoning: Reasoning, heading: boolean): HistoryRow[] {
  const kind = message.role === 'You' ? 'user' : message.role === 'Context' ? 'context' : 'assistant';
  const label = kind === 'user' ? '❯ User' : kind === 'context' ? '◆ Context' : '✦ Assistant';
  return [
    ...(!heading ? [] : [{ text: label, kind, bold: true, seq: message.seq } as HistoryRow]),
    ...partRows(message.parts, width, reasoning, message.seq),
    { text: '', kind: 'muted' as const, seq: message.seq },
  ];
}

const indexes = new WeakMap<Transcript, LayoutIndex>();
const noOverrides: ReadonlySet<number> = new Set();

/** Drop all terminal rows and layout metadata for an evicted or inactive transcript.
 * @param transcript - Transcript whose previously returned layout is no longer used.
 */
export function releaseHistoryLayout(transcript: Transcript): void {
  indexes.get(transcript)?.dispose(); indexes.delete(transcript);
}

/** Report what one transcript's layout still holds, for memory samples and diagnostics.
 *
 * The row cache is the only structure that grows with expanded reasoning and Markdown rows, and
 * its byte bound counts neither the span objects nor the incremental live-tail state.
 * @param transcript - Transcript whose layout should be measured.
 * @returns Cache and live-tail counters, or undefined when no layout was built yet.
 */
export function layoutStats(transcript: Transcript): { rows: number; cacheBytes: number; spans: number; spanChars: number; liveWraps: number; liveMarkdown: number } | undefined {
  const index = indexes.get(transcript);
  if (!index) return undefined;
  return { ...index.stats(), liveWraps: index.liveWraps.size, liveMarkdown: index.liveMarkdown.size };
}

/** Lay out an indexed conversation without concatenating its historical rows on every stream frame.
 * @param transcript - Selected session's semantic content and unfinished assistant output.
 * @param width - Available terminal columns.
 * @param reasoning - Global committed/completed reasoning fold mode.
 * @param overrides - Sequences whose fold mode differs from the global mode; replace the set on changes.
 * @param liveReasoning - Fold mode for completed live blocks; below 60 content columns it also folds active reasoning.
 * @returns Row count, sequence offsets, and a viewport reader; `lines` materializes all rows for exports only.
 */
export function historyLayout(transcript: Transcript, width: number, reasoning: Reasoning = 'row', overrides = noOverrides, liveReasoning: Reasoning = reasoning) {
  let index = indexes.get(transcript);
  if (!index || index.width !== width || index.reasoning !== reasoning || index.overrides !== overrides) {
    index = new LayoutIndex(width, reasoning, overrides); indexes.set(transcript, index);
  }
  index.update(transcript.messagesForWidth(width));
  const live = transcript.liveParts(width);
  const keys = new Set(live.map(part => part.key));
  for (const key of index.liveWraps.keys()) if (!keys.has(key)) index.liveWraps.delete(key);
  for (const key of index.liveMarkdown.keys()) if (!keys.has(key)) index.liveMarkdown.delete(key);
  const streamed: HistoryRow[] = live.length ? [
    ...(transcript.liveToolOnly || index.assistantSeen ? [] : [{ text: '✦ Assistant · streaming', kind: 'assistant' as const, bold: true }]),
    ...live.flatMap(part => {
      if (part.kind === 'text') {
        const previous = part.key === undefined ? undefined : index.liveMarkdown.get(part.key);
        const extendsPrevious = previous && part.text.length >= previous.length;
        // Include the preceding line so a split list marker or blank line can change Markdown parsing.
        const start = extendsPrevious ? part.text.lastIndexOf('\n', Math.max(0, previous.length - 2)) + 1 : 0;
        const rich = !!(extendsPrevious && previous.rich) || hasMarkdown(part.text.slice(start));
        if (part.key !== undefined) index.liveMarkdown.set(part.key, { length: part.text.length, rich });
        if (rich) {
          if (part.key !== undefined) index.liveWraps.delete(part.key);
          return partRows([part], width, liveReasoning);
        }
      }
      return livePartRows(part, index.liveWraps, width, liveReasoning);
    }),
  ] : [];
  const committed = index;
  const length = committed.length + streamed.length;
  const viewport = (start: number, end: number) => {
    start = Math.max(0, start); end = Math.min(length, end);
    if (end <= start) return [];
    return [...committed.viewport(start, end), ...streamed.slice(Math.max(0, start - committed.length), Math.max(0, end - committed.length))];
  };
  return { messages: index.messages, offsets: index.offsets, first: transcript.beforeSeq, length, liveOffset: committed.length, viewport,
    get cachedRowCount() { return committed.cachedRowCount; },
    get lines() { return viewport(0, length).map(row => row.text); } };
}
