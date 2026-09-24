/** Atomic per-session persistence for folded cost totals. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ensureDirectory, listEntries, modifiedAt, readText, removeFile, writePrivateFile } from '../storage/index.ts';
import type { CostTotal, DayTotal, SavedCost } from './types.ts';

/** Current on-disk ledger generation. A file of another generation is ignored: the next scan rebuilds it. */
const LEDGER_VERSION = 4;

/** The one file that holds a session's totals: the fixed per-session name. */
function ledgerName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`;
}

/** Load every session's stored totals; a file this build cannot read is left for the next scan.
 *
 * A slice is a projection of the host log, so a file this build cannot parse costs a rescan and never
 * stops the client: an unreadable or malformed one is skipped exactly like an older generation.
 * @param directory - Origin-scoped ledger directory, or undefined when persistence is disabled.
 * @returns The newest saved slice per session identity.
 */
export async function loadLedgers(directory: string | undefined): Promise<Map<string, SavedCost>> {
  const sessions = new Map<string, SavedCost>();
  if (!directory) return sessions;
  await ensureDirectory(directory);
  for (const name of await listEntries(directory)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const path = join(directory, name);
    const raw = await readText(path);
    // A file removed between listing and reading is simply absent.
    if (raw === undefined) continue;
    const saved = parseLedger(raw);
    if (saved === undefined) continue;
    if ((sessions.get(saved.sessionId)?.cut ?? -2) <= saved.cut) sessions.set(saved.sessionId, saved);
  }
  return sessions;
}

/** Write one session's totals unless the directory already holds a newer scan.
 *
 * The file is the system of record across processes, so a scan that opened an older snapshot must
 * not replace a cut another scan already persisted, and a process holding older decision rules must
 * not seal its totals over newer ones.
 * @param directory - Origin-scoped ledger directory.
 * @param saved - Complete slice to persist.
 * @returns Whether the directory now holds this slice.
 */
export async function saveLedger(directory: string, saved: SavedCost): Promise<boolean> {
  const path = join(directory, ledgerName(saved.sessionId));
  const existing = await readText(path);
  if (existing !== undefined) {
    const previous = parseLedger(existing);
    if (previous !== undefined && (previous.cut > saved.cut || previous.engine > saved.engine)) return false;
  }
  await writePrivateFile(path, JSON.stringify(saved) + '\n');
  return true;
}

/** Delete the ledger files a retention window no longer needs.
 *
 * Two rules, because a file this build cannot parse still has to age out: a loaded slice whose newest
 * day is outside the window goes immediately, and any ledger-shaped file whose modification time
 * predates the window goes whatever it holds — which is how a file of an older generation, one this
 * build can no longer read, is collected instead of sitting in the directory forever. A slice is
 * always written after the last day it records, so a file older than the window cannot hold a day
 * inside it: neither rule can delete a day the panel would still have shown.
 *
 * Retention is housekeeping, so every failure here is swallowed: a state directory that is read-only,
 * owned by someone else, or being written by another process costs a stale file, never a start.
 * @param directory - Origin-scoped ledger directory, or undefined when persistence is disabled.
 * @param floorDay - Oldest Beijing day still kept, YYYY-MM-DD.
 * @param loaded - Slices just loaded, so their own days decide before their timestamp does.
 * @returns Session identities whose loaded slice was deleted.
 */
export async function pruneLedgers(directory: string | undefined, floorDay: string,
  loaded: ReadonlyMap<string, SavedCost>): Promise<string[]> {
  if (!directory) return [];
  const dropped: string[] = [];
  try { await ensureDirectory(directory); } catch { return dropped; }
  const gone = new Set<string>();
  for (const [sessionId, session] of loaded) {
    // The days are sorted oldest first, so the last one is the newest thing this slice knows. A slice
    // with no days at all carries nothing — no total, no day — and goes too.
    const newest = session.days[session.days.length - 1]?.day;
    if (newest !== undefined && newest >= floorDay) continue;
    // A slice that cannot be removed stays loaded: the file is still there, so the totals it holds are
    // still this run's to report.
    if (!await dropLedger(directory, sessionId)) continue;
    gone.add(sessionId);
    dropped.push(sessionId);
  }
  const floorMs = Date.parse(`${floorDay}T00:00:00+08:00`);
  const kept = new Set([...loaded.keys()].filter(sessionId => !gone.has(sessionId)).map(ledgerName));
  let names: string[];
  try { names = await listEntries(directory); } catch { return dropped; }
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name) || kept.has(name)) continue;
    try {
      // A file removed between listing and stating is simply absent, and needs no deletion.
      const modified = await modifiedAt(join(directory, name));
      if (modified === undefined || modified >= floorMs) continue;
      await removeFile(join(directory, name));
    } catch { /* best effort: see the contract above */ }
  }
  return dropped;
}

/** Remove one slice, reporting whether the directory is now free of it.
 * @param directory - Origin-scoped ledger directory.
 * @param sessionId - Session whose slice should go.
 * @returns True when the file is gone; false when the removal failed and the file remains.
 */
async function dropLedger(directory: string, sessionId: string): Promise<boolean> {
  try { await removeFile(join(directory, ledgerName(sessionId))); return true; }
  catch { return false; }
}

/** Validate one persisted slice; another generation or an unreadable shape is absent. */
function parseLedger(raw: string): SavedCost | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== LEDGER_VERSION) return undefined;
  try {
    if (typeof record.sessionId !== 'string' || !Number.isSafeInteger(record.cut)) throw new Error('Invalid cost ledger');
    if (!Number.isSafeInteger(record.engine) || typeof record.catalog !== 'string') throw new Error('Invalid cost ledger');
    const total = validTotal(record.total);
    const days = validDays(record.days);
    if (total === undefined || days === undefined) throw new Error('Invalid cost ledger');
    if (!Array.isArray(record.unpriced) || record.unpriced.some(reason => typeof reason !== 'string')) throw new Error('Invalid cost ledger');
    return { version: LEDGER_VERSION, sessionId: record.sessionId, cut: record.cut as number, engine: record.engine as number,
      catalog: record.catalog, total, days, unpriced: record.unpriced as string[] };
  } catch { return undefined; }
}

/** Accept every stored day, or none: a partial day list would silently under-report a period.
 * @param value - The `days` field as parsed.
 * @returns The validated days, or undefined when any entry is unusable.
 */
function validDays(value: unknown): DayTotal[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days: DayTotal[] = [];
  for (const entry of value) {
    const total = validDay(entry);
    if (total === undefined) return undefined;
    days.push(total);
  }
  return days;
}

/** Accept one stored subtotal only when the amount is finite and the counts are whole.
 * Costs are fractional, so only the counts are required to be integers. */
function validTotal(value: unknown): CostTotal | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const total = value as Record<string, unknown>;
  const amount = total.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return undefined;
  const counts = [total.unknown, total.records];
  if (!counts.every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) return undefined;
  return { amount, unknown: total.unknown as number, records: total.records as number };
}

/** Accept one stored day bucket only when it also names the Beijing day it covers. */
function validDay(value: unknown): DayTotal | undefined {
  const total = validTotal(value);
  const day = (value as Record<string, unknown> | null)?.day;
  return total === undefined || typeof day !== 'string' || day === '' ? undefined : { day, ...total };
}
