/** Atomic per-session persistence for folded cost totals. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ensureDirectory, listEntries, readText, writePrivateFile } from '../storage/index.ts';
import type { CostTotal, DayTotal, SavedCost } from './types.ts';

/** Current on-disk ledger generation. A file of another generation is ignored: the next scan rebuilds it. */
const LEDGER_VERSION = 3;

/** The one file that holds a session's totals: the fixed per-session name. */
function ledgerName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`;
}

/** Load every session's stored totals; a file this build cannot read is left for the next scan.
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
    // A slice is a projection of the host log: one this build cannot use costs a rescan, not data.
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

/** Validate one persisted slice; another generation or an unreadable shape is absent. */
function parseLedger(raw: string): SavedCost | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== LEDGER_VERSION) return undefined;
  if (typeof record.sessionId !== 'string' || !Number.isSafeInteger(record.cut)) throw new Error('Invalid cost ledger');
  if (!Number.isSafeInteger(record.engine) || typeof record.catalog !== 'string') throw new Error('Invalid cost ledger');
  const total = validTotal(record.total);
  const day = validDay(record.day);
  if (total === undefined || day === undefined) throw new Error('Invalid cost ledger');
  if (!Array.isArray(record.unpriced) || record.unpriced.some(reason => typeof reason !== 'string')) throw new Error('Invalid cost ledger');
  return { version: LEDGER_VERSION, sessionId: record.sessionId, cut: record.cut as number, engine: record.engine as number,
    catalog: record.catalog, total, day, unpriced: record.unpriced as string[] };
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
