/** Lazy prompt recall owns its scan; the composer decides whether the result still belongs to it. */
import { useRef } from 'react';
import type { DraftReceipt } from './use-composer.ts';
import { errorText } from '../../text.ts';

/** Bound one key press even when many tool-only pages separate user messages. */
const PAGE_SCAN_LIMIT = 20;

interface RecallSource { readonly hasMore: boolean; readonly beforeSeq: number | undefined }

interface RecallOptions<Source extends RecallSource> {
  source: Source;
  draft: string;
  capture(): DraftReceipt;
  restore(receipt: DraftReceipt, read: () => string): void;
  previous(draft: string): string;
  refill(): boolean;
  hasPrevious(): boolean;
  older(signal: AbortSignal, source: Source): Promise<boolean>;
  run(work: (signal: AbortSignal) => Promise<boolean>): Promise<boolean | undefined>;
  notify(message: string): void;
}

/** No Controller or Transcript dependency: only the paging and recall capabilities it needs. */
export function useHistoryRecall<Source extends RecallSource>(options: RecallOptions<Source>) {
  const loading = useRef(false);
  return async () => {
    if (loading.current) return;
    const receipt = options.capture();
    const { source, draft } = options;
    const restore = () => options.restore(receipt, () => options.previous(draft));
    if (options.refill() || options.hasPrevious() || !source.hasMore) { restore(); return; }
    loading.current = true;
    try {
      const found = await options.run(async signal => {
        for (let page = 0; page < PAGE_SCAN_LIMIT; page++) {
          signal.throwIfAborted();
          if (source.beforeSeq === undefined || !source.hasMore) break;
          if (!await options.older(signal, source)) break;
          signal.throwIfAborted();
          // Startup backfill may have inserted the same prompts while this page was in flight.
          if (options.refill() || options.hasPrevious()) return true;
        }
        return false;
      });
      if (found) restore();
    } catch (error) {
      // Foreground cancellation is an expected end to a user-triggered scan.
      if (!(error instanceof Error && error.name === 'AbortError')) options.notify(errorText(error));
    } finally { loading.current = false; }
  };
}
