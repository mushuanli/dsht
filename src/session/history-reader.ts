/** Selected-session history I/O, with cancellation tied to the record or window being read. */
import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '../transport/client.ts';
import type { HostAccess } from '../transport/host.ts';
import { object } from '../json.ts';
import { toolLine } from '../text.ts';
import { Transcript } from './transcript.ts';
import type { HistorySearch } from './types.ts';

interface Selection { sessionId: string; revision: number; record: Transcript }

/** History reads cannot navigate, change status, or write another domain's state. */
export interface HistoryHost extends Pick<HostAccess, 'require' | 'online' | 'signal'> {
  selected(): Selection;
  current(selection: Selection): boolean;
  owns(transcript: Transcript): boolean;
  changed(): void;
}

interface ReadContext extends Selection { client: Client; signal: AbortSignal; check(): void }
interface ReadTask { abort: AbortController; source?: Transcript; promise: Promise<unknown> }
const SEARCH_MATCH_LIMIT = 200;

export class HistoryReader {
  private readonly tasks = new Set<ReadTask>();
  constructor(private readonly host: HistoryHost) {}

  /** A selection change cancels everything; closing one detached window cancels only its pages. */
  cancel(source?: Transcript): void {
    for (const task of this.tasks) if (source === undefined || task.source === source) task.abort.abort();
  }

  async settle(): Promise<void> { await Promise.allSettled([...this.tasks].map(task => task.promise)); }

  private read<T>(caller: AbortSignal | undefined, source: Transcript | undefined, work: (context: ReadContext) => Promise<T>, discard?: (value: T) => void): Promise<T> {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, this.host.signal(), ...(caller ? [caller] : [])]);
    // Register before dispatch so even a synchronous observer can cancel this operation.
    const task: ReadTask = { abort, source, promise: Promise.resolve() };
    const promise = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const selected = this.host.selected();
      const check = () => {
        signal.throwIfAborted();
        if (!this.host.online() || !this.host.current(selected)) throw new Error('Session changed while reading history');
        if (source !== undefined && !this.host.owns(source)) throw new Error('History window closed');
      };
      check();
      const value = await work({ ...selected, client: this.host.require(), signal, check });
      try { check(); return value; }
      catch (error) { discard?.(value); throw error; }
    }).finally(() => { this.tasks.delete(task); });
    task.promise = promise;
    this.tasks.add(task);
    return promise;
  }

  waitForHistory(signal: AbortSignal): Promise<void> {
    return this.read(signal, undefined, async context => {
      const deadline = Date.now() + context.client.timeoutMs;
      while (!context.record.ready) {
        context.check();
        if (Date.now() >= deadline) throw new Error('Session snapshot timed out');
        await delay(20, undefined, { signal: context.signal });
      }
      context.check();
    });
  }

  older(signal?: AbortSignal, transcript?: Transcript): Promise<void> {
    return this.read(signal, transcript, context => this.page(context, transcript ?? context.record));
  }

  private async page(context: ReadContext, transcript: Transcript): Promise<void> {
    context.check();
    if (!transcript.ready || !transcript.hasMore || transcript.beforeSeq === undefined) return;
    const before = transcript.beforeSeq;
    const result = await context.client.call('session/page', { request: {
      address: { kind: 'session', sessionId: context.sessionId }, throughSeq: transcript.cursor,
      beforeSeq: before, maxMessages: 80,
    } }, context.signal);
    context.check();
    if (!this.host.owns(transcript)) throw new Error('History window closed');
    transcript.addPage(result);
    this.host.changed();
    if (transcript.hasMore && (transcript.beforeSeq === undefined || transcript.beforeSeq >= before)) {
      throw new Error('Host history page did not advance');
    }
  }

  historyThrough(target: number | 'first', signal: AbortSignal): Promise<void> {
    return this.read(signal, undefined, async context => {
      const transcript = context.record;
      if (!transcript.ready) throw new Error('Wait for the session snapshot');
      while (transcript.hasMore && (target === 'first' || transcript.beforeSeq !== undefined && transcript.beforeSeq > target)) {
        await this.page(context, transcript);
      }
    });
  }

  searchHistory(query: string, signal: AbortSignal): Promise<HistorySearch> {
    return this.read(signal, undefined, async context => {
      const source = context.record;
      if (!source.ready) throw new Error('Wait for the session snapshot');
      const throughSeq = source.readThrough;
      const needle = query.toLowerCase();
      const result: HistorySearch = { items: [], truncated: false };
      const scan = (transcript: Transcript): boolean => {
        const messages = transcript.messages;
        for (let index = messages.length - 1; index >= 0; index--) {
          context.check();
          const message = messages[index]!;
          if (message.role === 'Tool') continue;
          const text = message.text;
          const match = text.toLowerCase().indexOf(needle);
          if (match < 0) continue;
          if (result.items.length === SEARCH_MATCH_LIMIT) { result.truncated = true; return false; }
          result.items.push({ seq: message.seq, role: message.role,
            preview: Buffer.from(toolLine(text.slice(Math.max(0, match - 40), match + needle.length + 100), 160)).toString('utf8') });
        }
        return true;
      };
      if (!scan(source)) return result;
      let beforeSeq = source.beforeSeq;
      let hasMore = source.hasMore;
      while (hasMore && beforeSeq !== undefined) {
        const page = object(await context.client.call('session/page', { request: {
          address: { kind: 'session', sessionId: context.sessionId }, throughSeq, beforeSeq, maxMessages: 80,
        } }, context.signal));
        context.check();
        const temporary = new Transcript();
        try {
          temporary.accept({ type: 'snapshot', cursor: throughSeq, assistantStream: { revision: 0 }, records: page.records, hasMore: page.hasMore });
          const next = temporary.beforeSeq;
          if (temporary.hasMore && (next === undefined || next >= beforeSeq)) throw new Error('Host history page did not advance');
          if (!scan(temporary)) return result;
          beforeSeq = next; hasMore = temporary.hasMore;
        } finally { temporary.dispose(); }
      }
      return result;
    });
  }

  /** The returned window belongs to the caller until it is installed as the reading view. */
  historyAt(target: number, signal: AbortSignal): Promise<Transcript> {
    return this.read(signal, undefined, async context => {
      const throughSeq = context.record.readThrough;
      const page = object(await context.client.call('session/page', { request: {
        address: { kind: 'session', sessionId: context.sessionId }, throughSeq,
        beforeSeq: target + 1, maxMessages: 80,
      } }, context.signal));
      context.check();
      const window = new Transcript();
      try {
        window.accept({ type: 'snapshot', cursor: throughSeq, assistantStream: { revision: 0 }, records: page.records, hasMore: page.hasMore });
        if (!window.messages.some(message => message.seq === target)) throw new Error('The host did not return the requested message');
        return window;
      } catch (error) { window.dispose(); throw error; }
    }, window => window.dispose());
  }
}
