/** Human transcript projection from durable events and ephemeral assistant chunks. */
import wrapAnsi from 'wrap-ansi';
import { array, object, safeText, string, type Json, type ObjectValue } from './wire.ts';

interface ToolSummary { name: string; operation?: string }

function toolSummary(block: ObjectValue): ToolSummary {
  let args: ObjectValue = {};
  if (typeof block.arguments === 'string' && block.arguments.trimStart().startsWith('{')) {
    try {
      const value: unknown = JSON.parse(block.arguments);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) args = value as ObjectValue;
    } catch { /* Partial or non-JSON arguments have no operation summary. */ }
  }
  const operation = [args.description, args.command, args.cmd, args.path, args.filePath, args.file_path, args.query]
    .find(value => typeof value === 'string' && value.trim());
  return { name: string(block.name), ...(typeof operation === 'string' ? { operation } : {}) };
}

/** Fit a tool operation to one terminal row without exposing the result body.
 * @param text - Tool name, status icon and optional operation.
 * @param width - Available terminal columns.
 * @returns A single line with an ellipsis when shortened.
 */
export function toolLine(text: string, width: number): string {
  const clean = safeText(text).replace(/\s+/gu, ' ').trim();
  if (width < 2) return width === 1 ? '…' : '';
  const options = { hard: true, wordWrap: false, trim: false };
  return wrapAnsi(clean, width, options).includes('\n')
    ? wrapAnsi(clean, width - 1, options).split('\n')[0] + '…' : clean;
}

/** Render known content blocks and preserve unknown plugin blocks as JSON. */
export function contentText(content: Json | undefined, tools?: ReadonlyMap<string, ToolSummary>, width = 100): string {
  return array(content).map(value => {
    const block = object(value);
    switch (block.type) {
      case 'text': return string(block.text);
      case 'reasoning': return `◇ ${string(block.text)}`;
      case 'tool-call': {
        const tool = toolSummary(block);
        return toolLine(`⚙ ${tool.name}${tool.operation ? ` · ${tool.operation}` : ''}`, width);
      }
      case 'tool-result': {
        const tool = tools?.get(String(block.toolCallId));
        return toolLine(`${block.isError ? '✗' : '✓'} ${tool?.name ?? 'tool'} · ${tool?.operation ?? (block.isError ? 'failed' : 'completed')}`, width);
      }
      default: return JSON.stringify(block);
    }
  }).map(safeText).join('\n');
}

/** A displayed message retains the durable sequence for stable reconciliation. */
export interface Message { seq: number; role: string; text: string; compact?: boolean }

/** Opening snapshots replace all state; durable events are deduplicated by sequence. */
export class Transcript {
  private events = new Map<number, ObjectValue>();
  private blocks = new Map<number, ObjectValue>();
  private attempt: string | undefined;
  private nextIndex = 0;
  private revision = 0;
  private legacyStream = false;
  /** Changes whenever a follow frame or older page can affect the rendered transcript. */
  version = 0;
  cursor = -1;
  hasMore = false;
  ready = false;

  /** Apply one follow frame; reject stream gaps so callers can reopen a snapshot. */
  accept(value: unknown): void {
    this.version++;
    const frame = object(value);
    switch (frame.type) {
      case 'snapshot': {
        this.ready = false;
        this.events.clear();
        this.blocks.clear();
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
    this.version++;
    const page = object(value);
    this.addRecords(array(page.records));
    this.hasMore = page.hasMore === true;
  }

  /** Start of the open durable turn, when its timestamp is present in the retained window. */
  get activeTurnStartedAt(): number | undefined {
    let start: number | undefined;
    for (const [, event] of [...this.events].sort(([a], [b]) => a - b)) {
      if (event.type === 'turn/start') start = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : undefined;
      else if (event.type === 'turn/end') start = undefined;
    }
    return start;
  }

  /** Earliest retained record, used with the opening cursor for backward paging. */
  get beforeSeq(): number | undefined { return [...this.events.keys()].sort((a, b) => a - b)[0]; }

  /** Return append-origin conversation only; model-only replacement copies stay hidden. */
  get messages(): Message[] { return this.messagesForWidth(100); }

  /** Project history with single-row tool operations at the caller's terminal width.
   * @param width - Available terminal columns.
   * @returns Conversation messages with compact tool-only rows.
   */
  messagesForWidth(width: number): Message[] {
    const result: Message[] = [];
    const tools = new Map<string, ToolSummary>();
    for (const [seq, event] of [...this.events].sort(([a], [b]) => a - b)) {
      if (event.surfaceOp !== 'append') continue;
      const data = object(event.data);
      if (event.type === 'user/message') {
        const source = data.source ? object(data.source) : undefined;
        result.push({ seq, role: source && source.kind !== 'user' ? 'Context' : 'You', text: contentText(data.content, tools, width) });
      }
      else if (event.type === 'assistant/message' || event.type === 'tool/result') {
        const message = object(data.message);
        const blocks = array(message.content).map(object);
        for (const block of blocks) {
          if (block.type === 'tool-call') tools.set(string(block.id), toolSummary(block));
        }
        const text = event.type === 'tool/result'
          ? contentText(blocks.filter(block => block.type === 'tool-result'), tools, width) || toolLine('✓ tool · completed', width)
          : contentText(message.content, tools, width);
        if (text) result.push({ seq, role: event.type === 'tool/result' ? 'Tool' : 'Assistant', text,
          compact: event.type === 'tool/result' || blocks.every(block => block.type === 'tool-call') });
      }
    }
    return result;
  }

  /** Text from the active attempt is transient and never duplicated into durable history. */
  get liveText(): string { return this.liveTextForWidth(100); }

  /** Whether the active stream contains only tool operations, with no assistant prose. */
  get liveToolOnly(): boolean { return this.blocks.size > 0 && [...this.blocks.values()].every(block => block.type === 'tool-call'); }

  /** Render live tool operations within a terminal row.
   * @param width - Available terminal columns.
   * @returns Transient assistant text with clipped tool rows.
   */
  liveTextForWidth(width: number): string {
    return contentText([...this.blocks].sort(([a], [b]) => a - b).map(([, b]) => b), undefined, width);
  }

  private addRecords(records: Json[]): void {
    for (const record of records) {
      const entry = object(record);
      if (entry.type !== 'event' && entry.type !== 'chunks') {
        throw new Error(`Unsupported history record type: ${typeof entry.type === 'string' ? entry.type.slice(0, 100) : typeof entry.type}`);
      }
      const event = object(entry.event);
      if (entry.type === 'chunks' && !['chunkrow/text-chunks', 'chunkrow/reasoning-chunks', 'chunkrow/tool-call-chunks'].includes(string(event.type))) {
        throw new Error(`Unsupported packed history event: ${string(event.type).slice(0, 100)}`);
      }
      this.events.set(number(event.seq), event);
    }
    if (this.legacyStream) this.rebuildLegacyStream();
  }

  /** Older hosts log chunks directly; replay only the unfinished attempt for live display. */
  private rebuildLegacyStream(): void {
    this.blocks.clear();
    let position = '';
    for (const [, event] of [...this.events].sort(([a], [b]) => a - b)) {
      if (['step/start', 'step/end', 'turn/end', 'assistant/message', 'assistant/attempt'].includes(string(event.type))) {
        this.blocks.clear();
        position = '';
      } else if (event.type === 'assistant/chunk' || string(event.type).startsWith('chunkrow/')) {
        const data = object(event.data);
        const nextPosition = `${number(data.turn)}:${number(data.step)}`;
        if (position !== nextPosition) this.blocks.clear();
        position = nextPosition;
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
    } else if (chunk.type === 'block-end') this.blocks.set(number(chunk.index), object(chunk.block));
  }
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid sequence number');
  return value;
}
