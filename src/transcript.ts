/** Human transcript projection from durable events and ephemeral assistant chunks. */
import { array, object, safeText, string, type Json, type ObjectValue } from './wire.ts';

/** Render known content blocks and preserve unknown plugin blocks as JSON. */
export function contentText(content: Json | undefined): string {
  return array(content).map(value => {
    const block = object(value);
    switch (block.type) {
      case 'text': return string(block.text);
      case 'reasoning': return `◇ ${string(block.text)}`;
      case 'tool-call': return `⚙ ${string(block.name)} ${string(block.arguments)}`;
      case 'tool-result': return `${block.isError ? '✗' : '↳'} ${contentText(block.content)}`;
      default: return JSON.stringify(block);
    }
  }).map(safeText).join('\n');
}

/** A displayed message retains the durable sequence for stable reconciliation. */
export interface Message { seq: number; role: string; text: string }

/** Opening snapshots replace all state; durable events are deduplicated by sequence. */
export class Transcript {
  private events = new Map<number, ObjectValue>();
  private blocks = new Map<number, ObjectValue>();
  private attempt: string | undefined;
  private nextIndex = 0;
  private revision = 0;
  private legacyStream = false;
  cursor = -1;
  hasMore = false;
  ready = false;

  /** Apply one follow frame; reject stream gaps so callers can reopen a snapshot. */
  accept(value: unknown): void {
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
    const page = object(value);
    this.addRecords(array(page.records));
    this.hasMore = page.hasMore === true;
  }

  /** Earliest retained record, used with the opening cursor for backward paging. */
  get beforeSeq(): number | undefined { return [...this.events.keys()].sort((a, b) => a - b)[0]; }

  /** Return append-origin conversation only; model-only replacement copies stay hidden. */
  get messages(): Message[] {
    const result: Message[] = [];
    for (const [seq, event] of [...this.events].sort(([a], [b]) => a - b)) {
      if (event.surfaceOp !== 'append') continue;
      const data = object(event.data);
      if (event.type === 'user/message') {
        const source = data.source ? object(data.source) : undefined;
        result.push({ seq, role: source && source.kind !== 'user' ? 'Context' : 'You', text: contentText(data.content) });
      }
      else if (event.type === 'assistant/message' || event.type === 'tool/result') {
        const message = object(data.message);
        const text = contentText(message.content);
        if (text) result.push({ seq, role: event.type === 'tool/result' ? 'Tool' : 'Assistant', text });
      }
    }
    return result;
  }

  /** Text from the active attempt is transient and never duplicated into durable history. */
  get liveText(): string { return contentText([...this.blocks].sort(([a], [b]) => a - b).map(([, b]) => b)); }

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
        arguments: (block ? string(block.arguments) : '') + string(chunk.argumentsDelta) });
    } else if (chunk.type === 'block-end') this.blocks.set(number(chunk.index), object(chunk.block));
  }
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Invalid sequence number');
  return value;
}
