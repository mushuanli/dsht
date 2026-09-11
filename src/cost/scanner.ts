/** Address and page one session's complete billing history over the host connection. */
import { RemoteError, type Client, type Subscription } from '../transport/client.ts';
import { array, errorText, object, string, type ObjectValue } from '../transport/wire.ts';
import { costRecords } from './records.ts';

/** Wire addresses for one `session/list` row, in the order the cost scan should try them.
 *
 * A subagent child is reachable only under its durable parent, and the list row omits the delivery
 * mode, so both modes are offered with the continuable form first.
 * @param session - One row from the host session list.
 * @returns One plain-session address, or both subagent forms when the row is a child.
 */
export function costAddresses(session: ObjectValue): ObjectValue[] {
  const sessionId = string(session.sessionId);
  const parentSessionId = typeof session.parentSessionId === 'string' ? session.parentSessionId : '';
  if (session.origin !== 'subagent' || parentSessionId === '') return [{ kind: 'session', sessionId }];
  return [
    { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'continuable' },
    { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'one-shot' },
  ];
}

/** Read one session's complete cost history, retrying a subagent child with its other delivery mode.
 * @param client - Authenticated host transport.
 * @param session - One row from the host session list.
 * @param signal - Cancels paging without cancelling any agent work.
 * @returns Opening cursor and the minimal billing events behind it.
 */
export async function sessionCostHistory(client: Client, session: ObjectValue, signal: AbortSignal): Promise<{ cursor: number; events: ObjectValue[] }> {
  let lastError: unknown;
  for (const address of costAddresses(session)) {
    try { return await readCostHistory(client, address, signal); }
    catch (error) {
      lastError = error;
      // Only a delivery-mode mismatch justifies the other form; every other failure is final here.
      if (!(error instanceof RemoteError && error.code === 'subagent/unauthorized')) throw error;
    }
  }
  throw lastError;
}

/** Page one addressed session's history into the billing events the ledger folds. */
async function readCostHistory(client: Client, address: ObjectValue, signal: AbortSignal): Promise<{ cursor: number; events: ObjectValue[] }> {
  const snapshot = await new Promise<ObjectValue>((resolve, reject) => {
    let sub: Subscription | undefined;
    const timeout = setTimeout(() => finish(new Error('Cost history snapshot timed out')), client.timeoutMs);
    const onAbort = () => finish(new Error('Cost refresh cancelled'));
    const finish = (error?: Error, frame?: ObjectValue) => {
      clearTimeout(timeout); signal.removeEventListener('abort', onAbort); sub?.cancel();
      if (error) reject(error); else resolve(frame!);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try { sub = client.subscribe('session/follow', { request: { address, maxMessages: 80, assistantStream: true } }, {
      item: value => { const frame = object(value); if (frame.type === 'snapshot') finish(undefined, frame); },
      end: error => finish(error ?? new Error('Cost history stream ended')),
    }); } catch (error) { finish(error instanceof Error ? error : new Error(errorText(error))); }
  });
  const cursor = snapshot.cursor;
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor)) throw new Error('Invalid cost history cursor');
  let page = snapshot; const events: ObjectValue[] = [];
  while (true) {
    signal.throwIfAborted();
    const records = array(page.records);
    events.push(...costRecords(records));
    if (!page.hasMore) break;
    const seqs = records.map(r => object(object(r).event).seq);
    if (!seqs.length || seqs.some(n => typeof n !== 'number' || !Number.isSafeInteger(n))) throw new Error('Invalid cost history page');
    const beforeSeq = Math.min(...seqs as number[]);
    page = object(await client.call('session/page', { request: { address, throughSeq: cursor, beforeSeq, maxMessages: 80 } }, signal));
    if (page.hasMore && array(page.records).every(r => Number(object(object(r).event).seq) >= beforeSeq)) throw new Error('Cost history page did not advance');
  }
  if (object(snapshot.header).isSeeded === true && !events.some(e => e.type === 'session/end-seed' && object(e.data).inherited === true)) throw new Error('Cannot attribute inherited session usage');
  return { cursor, events };
}
