/** Address and page one session's complete billing history over the host connection. */
import { RemoteError, type Client, type Subscription } from '../transport/client.ts';
import { array, errorText, object, type Json, type ObjectValue } from '../transport/wire.ts';
import { follow, page as readPage, type FollowSnapshot, type SessionAddress } from '../transport/dsh.ts';

/** The row facts a cost scan needs to address one session's history. */
export interface CostSession {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly origin?: string;
}
import { costRecords } from './records.ts';

/** Wire addresses for one `session/list` row, in the order the cost scan should try them.
 *
 * A subagent child is reachable only under its durable parent, and the list row omits the delivery
 * mode, so both modes are offered with the continuable form first.
 * @param session - One row from the host session list.
 * @returns One plain-session address, or both subagent forms when the row is a child.
 */
export function costAddresses(session: CostSession): SessionAddress[] {
  const parentSessionId = session.parentSessionId ?? '';
  if (session.origin !== 'subagent' || parentSessionId === '') return [{ kind: 'session', sessionId: session.sessionId }];
  return [
    { kind: 'subagent', parentSessionId, childSessionId: session.sessionId, mode: 'continuable' },
    { kind: 'subagent', parentSessionId, childSessionId: session.sessionId, mode: 'one-shot' },
  ];
}

/** Read one session's complete cost history, retrying a subagent child with its other delivery mode.
 * @param client - Authenticated host transport.
 * @param session - One row from the host session list.
 * @param signal - Cancels paging without cancelling any agent work.
 * @param onPage - Counts each history request, so a scan can report how much it re-read.
 * @param onRecords - Hands each page's raw records to the caller, which owns any further reading of
 *   them; the billing fold itself keeps only the minimal events below.
 * @returns Opening cursor and the minimal billing events behind it.
 */
export async function sessionCostHistory(client: Client, session: CostSession, signal: AbortSignal, onPage?: () => void,
  onRecords?: (records: readonly Json[]) => void): Promise<{ cursor: number; events: ObjectValue[] }> {
  let lastError: unknown;
  for (const address of costAddresses(session)) {
    try { return await readCostHistory(client, address, signal, onPage, onRecords); }
    catch (error) {
      lastError = error;
      // Only a delivery-mode mismatch justifies the other form; every other failure is final here.
      if (!(error instanceof RemoteError && error.code === 'subagent/unauthorized')) throw error;
    }
  }
  throw lastError;
}

/** Page one addressed session's history into the billing events the ledger folds. */
async function readCostHistory(client: Client, address: SessionAddress, signal: AbortSignal, onPage?: () => void,
  onRecords?: (records: readonly Json[]) => void): Promise<{ cursor: number; events: ObjectValue[] }> {
  signal.throwIfAborted();
  onPage?.();
  const snapshot = await new Promise<FollowSnapshot>((resolve, reject) => {
    let sub: Subscription | undefined;
    const timeout = setTimeout(() => finish(new Error('Cost history snapshot timed out')), client.timeoutMs);
    const onAbort = () => finish(new Error('Cost refresh cancelled'));
    const finish = (error?: Error, frame?: FollowSnapshot) => {
      clearTimeout(timeout); signal.removeEventListener('abort', onAbort); sub?.cancel();
      if (error) reject(error); else resolve(frame!);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try { sub = follow(client, { address }, {
      frame: frame => { if (frame.kind === 'snapshot') finish(undefined, frame.snapshot); },
      invalid: error => finish(error),
      end: error => finish(error ?? new Error('Cost history stream ended')),
    }); } catch (error) { finish(error instanceof Error ? error : new Error(errorText(error))); }
  });
  const cursor = snapshot.cursor;
  let records = [...snapshot.records];
  let hasMore = snapshot.hasMore;
  const events: ObjectValue[] = [];
  while (true) {
    signal.throwIfAborted();
    onRecords?.(records);
    events.push(...costRecords(records));
    if (!hasMore) break;
    const seqs = records.map(r => object(object(r).event).seq);
    if (!seqs.length || seqs.some(n => typeof n !== 'number' || !Number.isSafeInteger(n))) throw new Error('Invalid cost history page');
    const beforeSeq = Math.min(...seqs as number[]);
    onPage?.();
    const page = await readPage(client, { address, throughSeq: cursor, beforeSeq, maxMessages: 80 }, signal);
    if (page.hasMore && page.records.every(r => Number(object(object(r).event).seq) >= beforeSeq)) {
      throw new Error('Cost history page did not advance');
    }
    records = [...page.records]; hasMore = page.hasMore;
  }
  if (snapshot.headerSeeded && !events.some(e => e.type === 'session/end-seed' && object(e.data).inherited === true)) throw new Error('Cannot attribute inherited session usage');
  return { cursor, events };
}
