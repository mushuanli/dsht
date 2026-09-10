/** Indexed semantic history with bounded terminal-row caching and viewport-only materialization. */
import wrapAnsi from 'wrap-ansi';
import { toolLine, type Message, type MessagePart, type Transcript } from './transcript.ts';

/** Default fold mode; individual sequence overrides are view state, never stored content. */
export type Reasoning = 'row' | 'full';
/** Color semantics are independent of the selected terminal palette. */
export type RowKind = MessagePart['kind'] | 'user' | 'assistant' | 'context' | 'muted';
/** One visible terminal row; no remote ANSI is allowed into its text. */
export interface HistoryRow { text: string; kind: RowKind; bold?: boolean; seq?: number }
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
  }

  get cachedRowCount(): number { return this.cacheSize; }

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

function partRows(parts: MessagePart[], width: number, reasoning: Reasoning, seq?: number): HistoryRow[] {
  return parts.flatMap(part => {
    const cached = seq === undefined ? liveRows.get(part) : undefined;
    if (cached?.width === width && cached.reasoning === reasoning) return cached.rows;
    const fold = part.kind === 'reasoning' && reasoning === 'row' && (seq !== undefined || part.closed || width < 60);
    const text = fold ? toolLine(`◇ /think${seq === undefined ? ' live' : ` ${seq}`} · ${part.text.slice(2)}`, width) : part.text;
    const rows = wrapAnsi(text, width, { hard: true, trim: !['tool', 'success', 'error'].includes(part.kind) }).split('\n').map(text => ({ text, kind: part.kind, seq }));
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
  const streamed: HistoryRow[] = live.length ? [
    ...(transcript.liveToolOnly || index.assistantSeen ? [] : [{ text: '✦ Assistant · streaming', kind: 'assistant' as const, bold: true }]),
    ...partRows(live, width, liveReasoning),
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
