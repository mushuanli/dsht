/** Bounded background recall indexing, owned by one selected record and connection lifetime. */
import { setTimeout as delay } from 'node:timers/promises';
import type { HostAccess } from '../transport/host.ts';
import { object } from '../json.ts';
import { Transcript } from './transcript.ts';
import type { PromptCache, PromptIndex } from './info.ts';

interface Selection { sessionId: string; revision: number; record: Transcript; prompts: PromptIndex }
interface BackfillHost extends Pick<HostAccess, 'require' | 'signal' | 'online'> {
  current(selection: Selection): boolean;
  changed(): void;
}
interface Task { abort: AbortController; promise: Promise<void> }
const PAGE_LIMIT = 200;

export class PromptBackfill {
  private readonly tasks = new Set<Task>();
  constructor(private readonly host: BackfillHost, private readonly cache: PromptCache) {}

  cancel(): void { for (const task of this.tasks) task.abort.abort(); }
  async settle(): Promise<void> { await Promise.allSettled([...this.tasks].map(task => task.promise)); }

  start(selection: Selection): void {
    this.cancel();
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, this.host.signal()]);
    const task: Task = { abort, promise: Promise.resolve() };
    // Register before dispatch, including before any reentrant host callback.
    this.tasks.add(task);
    task.promise = Promise.resolve().then(async () => {
      const check = () => {
        signal.throwIfAborted();
        if (!this.host.online() || !this.host.current(selection)) throw new Error('Session changed while indexing prompts');
      };
      check();
      const client = this.host.require();
      const deadline = Date.now() + client.timeoutMs;
      const { record, prompts, sessionId } = selection;
      while (!record.ready) {
        check();
        if (Date.now() >= deadline) throw new Error('Session snapshot timed out');
        await delay(20, undefined, { signal });
      }
      check();
      const adopt = () => {
        const cached = this.cache.get(sessionId);
        if (!cached?.complete) return false;
        prompts.prepend(cached.prompts);
        prompts.settle(); prompts.markComplete();
        this.host.changed();
        return true;
      };
      if (adopt()) return;
      const throughSeq = record.readThrough;
      let beforeSeq = record.beforeSeq, hasMore = record.hasMore;
      for (let page = 0; hasMore && beforeSeq !== undefined && page < PAGE_LIMIT; page++) {
        check();
        const result = object(await client.call('session/page', { request: {
          address: { kind: 'session', sessionId }, throughSeq, beforeSeq, maxMessages: 80,
        } }, signal));
        check();
        const temporary = new Transcript();
        try {
          temporary.accept({ type: 'snapshot', cursor: throughSeq, assistantStream: { revision: 0 }, records: result.records, hasMore: result.hasMore });
          const next = temporary.beforeSeq;
          if (temporary.hasMore && (next === undefined || next >= beforeSeq)) throw new Error('Host history page did not advance');
          prompts.prepend(temporary.promptsSince(-1).prompts);
          // Bound each admitted page, even when the next request fails or never returns.
          prompts.settle();
          beforeSeq = next; hasMore = temporary.hasMore;
        } finally { temporary.dispose(); }
        if (adopt()) return;
      }
      if (!hasMore) {
        prompts.markComplete();
        this.cache.put(sessionId, { prompts: prompts.durableItems, complete: prompts.exhausted });
      }
      this.host.changed();
    }).catch(() => {
      // Cancellation or unavailable history leaves older prompts reachable through lazy paging.
    }).finally(() => { this.tasks.delete(task); });
  }
}
