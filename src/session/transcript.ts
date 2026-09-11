/** Human transcript projection from durable events and ephemeral assistant chunks. */
import sliceAnsi from 'slice-ansi';
import type { HistoryLimits } from './memory.ts';
import { array, object, safeText, string, type Json, type ObjectValue } from '../transport/wire.ts';

interface ToolSummary { name: string; operation?: string; command?: string }

function toolSummary(block: ObjectValue): ToolSummary {
  let args: ObjectValue = {};
  if (typeof block.arguments === 'string' && block.arguments.trimStart().startsWith('{')) {
    try {
      const value: unknown = JSON.parse(block.arguments);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) args = value as ObjectValue;
    } catch { /* Partial or non-JSON arguments have no operation summary. */ }
  }
  if (typeof block.operation === 'string') return { name: string(block.name), operation: block.operation, ...(typeof block.command === 'string' ? { command: block.command } : {}) };
  const operation = [args.description, args.command, args.cmd, args.path, args.filePath, args.file_path, args.query]
    .find(value => typeof value === 'string' && value.trim());
  const command = [args.command, args.cmd].find(value => typeof value === 'string' && value.trim());
  return { name: string(block.name), ...(typeof operation === 'string' ? { operation } : {}),
    ...(typeof command === 'string' && command !== operation ? { command: command.split(/\r?\n/)[0]! } : {}) };
}

/** Fit a tool operation to one terminal row without exposing the result body.
 * @param text - Tool name, status icon and optional operation.
 * @param width - Available terminal columns.
 * @returns A single line with an ellipsis when shortened.
 */
export function toolLine(text: string, width: number): string {
  const clean = safeText(text).replace(/\s+/gu, ' ').trim();
  if (width < 2) return width === 1 ? '…' : '';
  const clipped = sliceAnsi(clean, 0, width);
  return clipped.length < clean.length ? sliceAnsi(clean, 0, width - 1) + '…' : clean;
}

/** Render known content blocks and preserve unknown plugin blocks as JSON.
 * @param content - Message content blocks.
 * @param tools - Tool summaries by call ID, when retained history provides them.
 * @param width - Available terminal columns.
 * @param reasoning - `full` keeps streamed reasoning at length; `row` folds a committed block into one row.
 * @returns Blocks joined by newlines.
 */
export function contentText(content: Json | undefined, tools?: ReadonlyMap<string, ToolSummary>, width = 100,
  reasoning: 'row' | 'full' = 'full'): string {
  return array(content).map(value => {
    const block = object(value);
    switch (block.type) {
      case 'text': return string(block.text);
      case 'reasoning': return reasoning === 'full' ? `◇ ${string(block.text)}` : toolLine(`◇ ${string(block.text)}`, width);
      case 'tool-call': {
        const tool = toolSummary(block);
        return toolLine(`⚙ ${tool.name}${tool.operation ? ` · ${tool.operation.split(/\r?\n/)[0]}` : ''}`, width)
          + (tool.command ? `\n${' '.repeat(Math.min(2, width))}${toolLine(`$ ${tool.command}`, Math.max(0, width - 2))}` : '');
      }
      case 'tool-result': {
        const tool = tools?.get(String(block.toolCallId)) ?? (typeof block.name === 'string' ? toolSummary(block) : undefined);
        return toolLine(`${block.isError ? '✗' : '✓'} ${tool?.name ?? 'tool'} · ${tool?.operation ?? (block.isError ? 'failed' : 'completed')}`, width);
      }
      default: return JSON.stringify(block);
    }
  }).map(safeText).join('\n');
}

/** Event types that contribute a displayed message; other retained events only affect live state. */
const DISPLAY_EVENTS = new Set(['user/message', 'assistant/message', 'tool/result']);

/** Semantic content stays separate from terminal rows, styles, and fold state. */
export interface MessagePart {
  kind: 'text' | 'reasoning' | 'tool' | 'success' | 'error';
  text: string;
  /** Closed live reasoning can fold before the assistant message is committed. */
  closed?: boolean;
}

/** A displayed message retains the durable sequence for stable reconciliation. */
export interface Message {
  seq: number;
  role: string;
  text: string;
  parts: MessagePart[];
  compact?: boolean;
  /** One-row rendering of committed reasoning, used only while the conversation folds reasoning. */
  folded?: string;
}

/** Lightweight reasoning navigation row; summaries never contain a copy of the full thought. */
export interface ThoughtEntry { seq: number; promptSeq?: number; prompt: string; preview: string }

/** Opening snapshots replace all state; durable events are deduplicated by sequence. */
export class Transcript {
  private sizes = new Map<number, number>();
  private storedBytes = 0;
  private throughSeq = -1;
  private promptBeforeWindow: { seq: number; text: string } | undefined;
  private disposed = false;
  /** Increments when cached bodies are evicted, so view state can drop obsolete references. */
  memoryRevision = 0;
  private transientSeqs = new Set<number>();
  private events = new Map<number, ObjectValue>();
  private blocks = new Map<number, ObjectValue>();
  private thoughtIndex: { revision: number; entries: ThoughtEntry[]; prompt: string } | undefined;
  private liveProjection = new WeakMap<ObjectValue, { width: number; part: MessagePart }>();
  private closedBlocks = new Set<number>();
  private oldestSeq: number | undefined;
  private turnMarker: { seq: number; start?: number } | undefined;
  private attempt: string | undefined;
  private nextIndex = 0;
  private revision = 0;
  private legacyStream = false;
  private keysDirty = true;
  private sortedSeqs: number[] = [];
  private projectionRevision = 0;
  private projection: { revision: number; width: number; messages: Message[] } | undefined;
  private displaySeqsRevision = -1;
  private displayed: number[] = [];
  private displayedMessages = new WeakMap<ObjectValue, { width: number; prefix: number; status: string; message: Message | undefined }>();
  private legacyDirty = true;
  private legacyPosition = '';
  private legacySeq = -1;
  /** Changes whenever a follow frame or older page can affect the rendered transcript. */
  version = 0;
  cursor = -1;
  hasMore = false;
  ready = false;

  /** Apply one follow frame; reject stream gaps so callers can reopen a snapshot. */
  accept(value: unknown): void {
    if (this.disposed) return;
    this.version++;
    const frame = object(value);
    switch (frame.type) {
      case 'snapshot': {
        this.ready = false;
        this.events.clear();
        this.sizes.clear(); this.storedBytes = 0; this.throughSeq = -1; this.promptBeforeWindow = undefined;
        this.dropProjections();
        this.transientSeqs.clear();
        this.closedBlocks.clear();
        this.oldestSeq = undefined;
        this.turnMarker = undefined;
        this.blocks.clear();
        this.keysDirty = true;
        this.projectionRevision++;
        this.legacyDirty = true;
        this.legacyStream = frame.assistantStream === undefined;
        this.cursor = number(frame.cursor);
        this.hasMore = frame.hasMore === true;
        this.addRecords(array(frame.records));
        const baseline = object(frame.assistantStream ?? { revision: 0 });
        this.revision = number(baseline.revision);
        this.attempt = undefined;
        if (baseline.activeAttempt) {
          const attempt = object(baseline.activeAttempt);
          this.attempt = string(attempt.attemptId);
          this.nextIndex = number(attempt.nextIndex);
          for (const value of array(attempt.stream)) {
            const record = object(value);
            if (record.type === 'chunk') this.chunk(object(record.chunk));
            else if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
              this.chunk({ type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta',
                index: number(record.index), text: array(record.texts).map(string).join('') });
            } else if (record.type === 'tool-call-chunks') {
              this.chunk({ type: 'tool-call-delta', index: number(record.index), id: string(record.id),
                name: typeof record.name === 'string' ? record.name : '',
                argumentsDelta: array(record.args).map(string).join('') });
            }
          }
        }
        this.ready = true;
        break;
      }
      case 'event':
      case 'chunks': this.addRecords([frame]); break;
      case 'assistant-stream': {
        const live = object(frame.frame);
        if (number(live.revision) !== this.revision + 1) throw new Error('Assistant stream revision gap');
        this.revision = number(live.revision);
        if (live.type === 'start') {
          this.blocks.clear();
          this.closedBlocks.clear();
          this.attempt = string(live.attemptId);
          this.nextIndex = 0;
        } else {
          if (live.attemptId !== this.attempt || number(live.index) !== this.nextIndex) {
            throw new Error('Assistant stream chunk gap');
          }
          if (live.type === 'chunk') { this.chunk(object(live.chunk)); this.nextIndex++; }
          else if (live.type === 'end') { this.attempt = undefined; this.blocks.clear(); }
          else throw new Error('Unknown assistant stream frame');
        }
        break;
      }
      default: throw new Error('Unknown session follow frame');
    }
  }

  /** Add an older page without replacing the live tail. */
  addPage(value: unknown): void {
    if (this.disposed) return;
    this.version++;
    const page = object(value);
    this.addRecords(array(page.records));
    this.hasMore = page.hasMore === true;
  }

  /** Durable read cutoff includes followed records that were not present in the opening snapshot. */
  get readThrough(): number { return Math.max(this.cursor, this.throughSeq); }

  /** Estimated UTF-16 JSON payload bytes; excludes object overhead and unfinished stream blocks. */
  get retainedBytes(): number { return this.storedBytes; }

  /** Release reloadable prefix records with hysteresis, retaining a recent tail and active legacy chunks.
   * @param limits - Soft record and payload budgets; callers suspend this operation while reading history.
   * @returns Number of removed records. Paging remains possible at the advanced durable cutoff.
   */
  trimHistory(limits: HistoryLimits): number {
    if (this.disposed || (this.events.size <= limits.maxRecords && this.storedBytes <= limits.maxBytes)) return 0;
    const keys = this.sortedKeys();
    const keep = Math.min(32, Math.max(1, Math.floor(limits.maxRecords / 4)));
    const targetRecords = Math.max(keep, Math.floor(limits.maxRecords * 0.75));
    const targetBytes = limits.maxBytes * 0.75;
    let count = 0, bytes = this.storedBytes;
    while (count < keys.length - keep && (keys.length - count > targetRecords || bytes > targetBytes)) {
      const seq = keys[count]!;
      // The active legacy attempt may need its earliest chunks when an older page is replayed.
      if (this.transientSeqs.has(seq)) break;
      bytes -= this.sizes.get(seq) ?? 0; count++;
    }
    if (!count) return 0;
    const cutoff = keys[count]!;
    const tools = new Map<string, ToolSummary>();
    for (const seq of keys) {
      const event = this.events.get(seq)!;
      if (!DISPLAY_EVENTS.has(string(event.type)) || event.surfaceOp !== 'append') continue;
      const data = object(event.data);
      if (event.type === 'user/message') {
        if (seq < cutoff && (!data.source || object(data.source).kind === 'user')) this.promptBeforeWindow = { seq, text: toolLine(contentText(data.content), 120) };
        continue;
      }
      const blocks = array(object(data.message).content).map(object);
      for (const block of blocks) if (block.type === 'tool-call') tools.set(string(block.id), toolSummary(block));
      if (seq >= cutoff && event.type === 'tool/result') {
        const content = blocks.map(block => block.type === 'tool-result' && tools.has(string(block.toolCallId))
          ? { ...block, ...tools.get(string(block.toolCallId))! } : block);
        this.storeEvent(seq, { ...event, data: { message: { content } } });
      }
    }
    for (let index = 0; index < count; index++) this.deleteEvent(keys[index]!);
    this.oldestSeq = cutoff;
    this.cursor = Math.max(this.cursor, this.throughSeq);
    this.hasMore = true;
    this.keysDirty = true;
    this.projectionRevision++; this.version++; this.memoryRevision++;
    this.dropProjections();
    return count;
  }

  /** Empty an inactive session immediately; late frames cannot repopulate a disposed transcript. */
  dispose(): void {
    this.disposed = true;
    this.events.clear(); this.sizes.clear(); this.storedBytes = 0;
    this.blocks.clear(); this.closedBlocks.clear(); this.transientSeqs.clear();
    this.sortedSeqs = []; this.displayed = []; this.promptBeforeWindow = undefined;
    this.oldestSeq = undefined; this.turnMarker = undefined; this.attempt = undefined; this.legacyPosition = '';
    this.cursor = -1; this.throughSeq = -1; this.hasMore = false; this.ready = false;
    this.dropProjections(); this.version++; this.memoryRevision++;
  }

  private dropProjections(): void {
    this.projection = undefined; this.thoughtIndex = undefined;
    this.sortedSeqs = []; this.displayed = []; this.keysDirty = true; this.displaySeqsRevision = -1;
    this.displayedMessages = new WeakMap(); this.liveProjection = new WeakMap();
  }

  private storeEvent(seq: number, event: ObjectValue): void {
    const bytes = JSON.stringify(event).length * 2;
    this.storedBytes += bytes - (this.sizes.get(seq) ?? 0);
    this.sizes.set(seq, bytes); this.events.set(seq, event);
  }

  private deleteEvent(seq: number): void {
    this.storedBytes -= this.sizes.get(seq) ?? 0;
    this.sizes.delete(seq); this.events.delete(seq);
  }

  /** Start of the open durable turn, when its timestamp is present in the retained window. */
  get activeTurnStartedAt(): number | undefined {
    return this.turnMarker?.start;
  }

  /** Cached prompt/reasoning summaries, oldest first; stream deltas never invalidate this index. */
  get thoughts(): ThoughtEntry[] {
    if (this.thoughtIndex?.revision === this.projectionRevision) return this.thoughtIndex.entries;
    const entries: ThoughtEntry[] = [];
    let prompt = this.promptBeforeWindow?.text ?? 'Prompt precedes loaded history';
    let promptSeq = this.promptBeforeWindow?.seq;
    for (const seq of this.displaySeqs()) {
      const event = this.events.get(seq)!;
      if (event.surfaceOp !== 'append') continue;
      const data = object(event.data);
      if (event.type === 'user/message') {
        if (!data.source || object(data.source).kind === 'user') { prompt = toolLine(contentText(data.content), 120); promptSeq = seq; }
      } else if (event.type === 'assistant/message') {
        const reasoning = array(object(data.message).content).map(object).find(block => block.type === 'reasoning');
        if (reasoning) entries.push({ seq, promptSeq, prompt, preview: toolLine(string(reasoning.text), 120) });
      }
    }
    this.thoughtIndex = { revision: this.projectionRevision, entries, prompt };
    return entries;
  }

  /** Latest loaded user prompt summary, sharing the durable thought index. */
  get latestPrompt(): string { void this.thoughts; return this.thoughtIndex!.prompt; }

  /** Number of semantic records and unfinished legacy chunks held by the client. */
  get retainedRecordCount(): number { return this.events.size; }

  /** Earliest loaded record, used with the opening cursor for backward paging. */
  get beforeSeq(): number | undefined { return this.oldestSeq; }

  /** Retained sequences in ascending order; resorted only when a retained event changes. */
  private sortedKeys(): number[] {
    if (this.keysDirty) {
      this.sortedSeqs = [...this.events.keys()].sort((a, b) => a - b);
      this.keysDirty = false;
    }
    return this.sortedSeqs;
  }

  /** Sequences of the event types that contribute a displayed message. */
  private displaySeqs(): number[] {
    if (this.displaySeqsRevision !== this.projectionRevision) {
      this.displayed = this.sortedKeys().filter(seq => DISPLAY_EVENTS.has(string(this.events.get(seq)!.type)));
      this.displaySeqsRevision = this.projectionRevision;
    }
    return this.displayed;
  }

  /** Return append-origin conversation only; model-only replacement copies stay hidden. */
  get messages(): Message[] { return this.messagesForWidth(100); }

  /** Project history with single-row tool operations at the caller's terminal width.
   * @param width - Available terminal columns.
   * @returns Conversation messages with compact tool-only rows; the array is shared and must not be mutated.
   */
  messagesForWidth(width: number): Message[] {
    if (this.projection?.revision === this.projectionRevision && this.projection.width === width) return this.projection.messages;
    const messages = this.project(width);
    this.projection = { revision: this.projectionRevision, width, messages };
    return messages;
  }

  /** Build the message list, reusing each unchanged event's earlier projection at the same width. */
  private project(width: number): Message[] {
    const result: Message[] = [];
    const tools = new Map<string, ToolSummary>();
    const outcomes = new Map<string, boolean>();
    const calls = new Set<string>();
    for (const seq of this.displaySeqs()) {
      const event = this.events.get(seq)!;
      if (event.surfaceOp !== 'append' || event.type === 'user/message') continue;
      for (const block of array(object(object(event.data).message).content).map(object)) {
        if (block.type === 'tool-call') calls.add(string(block.id));
        if (block.type === 'tool-result') outcomes.set(string(block.toolCallId), block.isError === true);
      }
    }
    for (const seq of this.displaySeqs()) {
      const event = this.events.get(seq)!;
      if (event.surfaceOp !== 'append') continue;
      const data = object(event.data);
      const isUser = event.type === 'user/message';
      const blocks = isUser ? [] : array(object(data.message).content).map(object);
      for (const block of blocks) {
        if (block.type === 'tool-call') tools.set(string(block.id), toolSummary(block));
      }
      const status = blocks.map(block => block.type === 'tool-call' ? String(outcomes.get(string(block.id)))
        : block.type === 'tool-result' ? String(calls.has(string(block.toolCallId))) : '').join(',');
      const cached = this.displayedMessages.get(event);
      if (cached && cached.width === width && cached.prefix === tools.size && cached.status === status) {
        if (cached.message) result.push(cached.message);
        continue;
      }
      const role = isUser ? (data.source && object(data.source).kind !== 'user' ? 'Context' : 'You')
        : event.type === 'tool/result' ? 'Tool' : 'Assistant';
      const content = isUser ? array(data.content).map(object) : event.type === 'tool/result' ? blocks.filter(block => block.type === 'tool-result' && !calls.has(string(block.toolCallId))) : blocks;
      const parts = content.map(block => {
        const outcome = block.type === 'tool-call' ? outcomes.get(string(block.id)) : undefined;
        if (outcome !== undefined) return {
          kind: outcome ? 'error' as const : 'success' as const,
          text: contentText([block], tools, width).replace(/^⚙/, outcome ? '✗' : '✓'),
        };
        return ({
        kind: block.type === 'reasoning' ? 'reasoning' as const : block.type === 'tool-call' ? 'tool' as const
          : block.type === 'tool-result' ? block.isError ? 'error' as const : 'success' as const : 'text' as const,
        text: contentText([block], tools, width),
      }); }).filter(part => part.text);
      if (!parts.length && event.type === 'tool/result' && !blocks.some(block => block.type === 'tool-result')) parts.push({ kind: 'success', text: toolLine('✓ tool · completed', width) });
      const message: Message | undefined = parts.length ? { seq, role, parts,
        get text() { return parts.map(part => part.text).join('\n'); },
        get folded() { return parts.some(part => part.kind === 'reasoning')
          ? parts.map(part => part.kind === 'reasoning' ? toolLine(part.text, width) : part.text).join('\n') : undefined; },
        ...(isUser ? {} : { compact: event.type === 'tool/result' || blocks.every(block => block.type === 'tool-call') }) } : undefined;
      this.displayedMessages.set(event, { width, prefix: tools.size, status, message });
      if (message) result.push(message);
    }
    return result;
  }

  /** Text from the active attempt is transient and never duplicated into durable history. */
  get liveText(): string { return this.liveTextForWidth(100); }

  /** Attempt identity resets the view's live fold preference between responses. */
  get liveAttemptKey(): string | undefined { return this.attempt ?? (this.legacyPosition || undefined); }

  /** Whether an active attempt has content, without joining its potentially long reasoning. */
  get hasLiveContent(): boolean { return this.blocks.size > 0; }

  /** Whether the active stream contains only tool operations, with no assistant prose. */
  get liveToolOnly(): boolean { return this.blocks.size > 0 && [...this.blocks.values()].every(block => block.type === 'tool-call'); }

  /** Render live tool operations within a terminal row.
   * @param width - Available terminal columns.
   * @returns Transient assistant text with clipped tool rows.
   */
  liveTextForWidth(width: number): string {
    return contentText([...this.blocks].sort(([a], [b]) => a - b).map(([, b]) => b), undefined, width, 'full');
  }

  /** Live semantic blocks; completed reasoning folds independently of the unfinished answer.
   * @param width - Terminal width used for compact tool summaries.
   * @returns Ordered blocks without terminal style escapes.
   */
  liveParts(width: number): MessagePart[] {
    return [...this.blocks].sort(([a], [b]) => a - b).map(([index, block]) => {
      const closed = this.closedBlocks.has(index);
      const cached = this.liveProjection.get(block);
      if (cached?.width === width && cached.part.closed === closed) return cached.part;
      const part: MessagePart = {
        kind: block.type === 'reasoning' ? 'reasoning' : block.type === 'tool-call' ? 'tool' : 'text',
        text: cached?.width === width ? cached.part.text : contentText([block], undefined, width), closed,
      };
      this.liveProjection.set(block, { width, part }); return part;
    });
  }

  private addRecords(records: Json[]): void {
    const added: ObjectValue[] = [];
    for (const record of records) {
      const entry = object(record);
      if (entry.type !== 'event' && entry.type !== 'chunks') {
        throw new Error(`Unsupported history record type: ${typeof entry.type === 'string' ? entry.type.slice(0, 100) : typeof entry.type}`);
      }
      const event = object(entry.event);
      if (entry.type === 'chunks' && !['chunkrow/text-chunks', 'chunkrow/reasoning-chunks', 'chunkrow/tool-call-chunks'].includes(string(event.type))) {
        throw new Error(`Unsupported packed history event: ${string(event.type).slice(0, 100)}`);
      }
      const seq = number(event.seq);
      this.oldestSeq = Math.min(this.oldestSeq ?? seq, seq);
      this.throughSeq = Math.max(this.throughSeq, seq);
      if ((event.type === 'turn/start' || event.type === 'turn/end') && seq >= (this.turnMarker?.seq ?? -1)) {
        this.turnMarker = { seq, start: event.type === 'turn/start' && typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : undefined };
      }
      const current = this.events.get(seq);
      this.storeEvent(seq, retainedEvent(event));
      if (!DISPLAY_EVENTS.has(string(event.type))) this.transientSeqs.add(seq); else this.transientSeqs.delete(seq);
      if (current === event) continue;
      added.push(event);
      if (this.keysDirty || seq <= (this.sortedSeqs[this.sortedSeqs.length - 1] ?? -1)) this.keysDirty = true;
      else this.sortedSeqs.push(seq);
      if (DISPLAY_EVENTS.has(string(event.type))) this.projectionRevision++;
      if (seq <= this.legacySeq) this.legacyDirty = true;
    }
    if (this.legacyStream) this.foldLegacy(added);
    // Only the unfinished legacy attempt needs chunk payloads for an older-page replay.
    let through: number | undefined;
    for (const event of added) if (['step/start', 'step/end', 'turn/end', 'assistant/message', 'assistant/attempt'].includes(string(event.type))) through = Math.max(through ?? -1, number(event.seq));
    if (!this.legacyStream || through !== undefined) {
      for (const seq of this.transientSeqs) {
        if (!this.legacyStream || seq < through!) {
          this.deleteEvent(seq); this.transientSeqs.delete(seq); this.keysDirty = true;
        }
      }
    }
  }

  /** Older hosts log chunks directly; fold the unfinished attempt into the live tail for display.
   * A page behind the folded position, or a replaced event, forces a full re-fold; streamed chunks extend it.
   */
  private foldLegacy(added: ObjectValue[]): void {
    let events: ObjectValue[];
    if (this.legacyDirty) {
      this.blocks.clear();
      this.closedBlocks.clear();
      this.legacyPosition = '';
      this.legacySeq = -1;
      this.legacyDirty = false;
      events = this.sortedKeys().map(seq => this.events.get(seq)!);
    } else {
      events = added.filter(event => number(event.seq) > this.legacySeq).sort((a, b) => number(a.seq) - number(b.seq));
    }
    for (const event of events) {
      this.legacySeq = Math.max(this.legacySeq, number(event.seq));
      if (['step/start', 'step/end', 'turn/end', 'assistant/message', 'assistant/attempt'].includes(string(event.type))) {
        this.blocks.clear();
        this.closedBlocks.clear();
        this.legacyPosition = '';
      } else if (event.type === 'assistant/chunk' || string(event.type).startsWith('chunkrow/')) {
        const data = object(event.data);
        const nextPosition = `${number(data.turn)}:${number(data.step)}`;
        if (this.legacyPosition !== nextPosition) { this.blocks.clear(); this.closedBlocks.clear(); }
        this.legacyPosition = nextPosition;
        switch (event.type) {
          case 'assistant/chunk': this.chunk(object(data.chunk)); break;
          case 'chunkrow/text-chunks':
          case 'chunkrow/reasoning-chunks': {
            const texts = array(data.texts).map(string);
            this.validatePackedTiming(data, texts.length);
            this.chunk({ type: event.type === 'chunkrow/text-chunks' ? 'text-delta' : 'reasoning-delta',
              index: number(data.index), text: texts.join('') });
            break;
          }
          case 'chunkrow/tool-call-chunks': {
            const args = array(data.args).map(string);
            this.validatePackedTiming(data, args.length);
            this.chunk({ type: 'tool-call-delta', index: number(data.index), id: string(data.id),
              ...(data.name === undefined ? {} : { name: string(data.name) }), argumentsDelta: args.join('') });
            break;
          }
        }
      }
    }
  }

  private validatePackedTiming(data: ObjectValue, count: number): void {
    if (count === 0 || array(data.dt).length !== count - 1) throw new Error('Invalid packed history member count');
  }
  private chunk(chunk: ObjectValue): void {
    if (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta') {
      for (const [index, block] of this.blocks) if (block.type === 'reasoning' && index !== chunk.index) this.closedBlocks.add(index);
    }
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const index = number(chunk.index);
      const block = this.blocks.get(index);
      this.blocks.set(index, { type: chunk.type === 'text-delta' ? 'text' : 'reasoning',
        text: (block ? string(block.text) : '') + string(chunk.text) });
    } else if (chunk.type === 'tool-call-delta') {
      const index = number(chunk.index);
      const block = this.blocks.get(index);
      this.blocks.set(index, { type: 'tool-call', id: string(chunk.id),
        name: typeof chunk.name === 'string' ? chunk.name : block?.name ?? '',
        arguments: '' });
    } else if (chunk.type === 'block-end') {
      this.blocks.set(number(chunk.index), object(chunk.block));
      this.closedBlocks.add(number(chunk.index));
    }
  }
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid sequence number');
  return value;
}

/** Keep only user-visible content in durable client memory; the host owns raw tool results. */
function retainedEvent(event: ObjectValue): ObjectValue {
  if (!DISPLAY_EVENTS.has(string(event.type))) return event;
  if (event.surfaceOp !== 'append') return { seq: event.seq!, type: event.type! };
  const data = object(event.data);
  const clean = (value: Json): Json => {
    const block = object(value);
    if (block.type === 'tool-call') return { type: 'tool-call', id: block.id!, ...toolSummary(block) } as ObjectValue;
    if (block.type === 'tool-result') return { type: 'tool-result', toolCallId: block.toolCallId!, isError: block.isError === true };
    return block;
  };
  return { seq: event.seq!, type: event.type!, surfaceOp: 'append', data: event.type === 'user/message'
    ? { content: data.content!, ...(data.source ? { source: data.source } : {}) }
    : { message: { content: array(object(data.message).content).filter(block => event.type !== 'tool/result' || object(block).type === 'tool-result').map(clean) } } };
}
