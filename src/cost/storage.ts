/** Atomic per-session persistence for the immutable charge ledger. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Charge, SavedCost } from './types.ts';

/** Current on-disk ledger generation. Files of another generation are ignored, not migrated. */
const LEDGER_VERSION = 2;

/** Load every complete session cut under one origin directory.
 *
 * Each session keeps its highest cut; a file of another generation or an unreadable shape is
 * treated as absent so the next scan rebuilds it.
 * @param directory - Origin-scoped ledger directory, or undefined when persistence is disabled.
 * @returns The newest saved slice per session identity.
 */
export async function loadLedgers(directory: string | undefined): Promise<Map<string, SavedCost>> {
  const sessions = new Map<string, SavedCost>();
  if (!directory) return sessions;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    let raw: string;
    try { raw = await readFile(join(directory, name), 'utf8'); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error; }
    const saved = parseLedger(raw);
    if (saved === undefined) continue;
    if ((sessions.get(saved.sessionId)?.cut ?? -2) <= saved.cut) sessions.set(saved.sessionId, saved);
  }
  return sessions;
}

/** Write one session cut atomically and drop that session's older cuts.
 * @param directory - Origin-scoped ledger directory.
 * @param saved - Complete slice to persist.
 */
export async function saveLedger(directory: string, saved: SavedCost): Promise<void> {
  const prefix = createHash('sha256').update(saved.sessionId).digest('hex') + '-';
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(saved) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, `${prefix}${saved.cut}.json`));
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  for (const name of await readdir(directory)) {
    if (name.startsWith(prefix) && name.endsWith('.json') && Number(name.slice(prefix.length, -5)) < saved.cut) {
      await unlink(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

/** Validate one persisted ledger; another generation or an unreadable shape is absent. */
function parseLedger(raw: string): SavedCost | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== LEDGER_VERSION) return undefined;
  if (typeof record.sessionId !== 'string' || !Number.isSafeInteger(record.cut) || !Array.isArray(record.charges)) {
    throw new Error('Invalid cost ledger');
  }
  const charges = record.charges as unknown[];
  if (!charges.every(validCharge)) throw new Error('Invalid cost ledger');
  return { version: LEDGER_VERSION, sessionId: record.sessionId, cut: record.cut as number, charges: charges as Charge[] };
}

/** One charge is valid when every recorded field is present with the type the fold writes. */
function validCharge(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.key !== 'string' || typeof c.provider !== 'string' || typeof c.model !== 'string') return false;
  if (c.priceId !== undefined && typeof c.priceId !== 'string') return false;
  if (c.reason !== undefined && typeof c.reason !== 'string') return false;
  if (c.amount !== undefined && (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount < 0)) return false;
  if (c.estimated !== undefined && c.estimated !== true) return false;
  if (c.time !== undefined && (typeof c.time !== 'number' || !Number.isFinite(c.time) || c.time < 0 || c.time > 8.64e15)) return false;
  if (c.usage !== undefined) {
    if (typeof c.usage !== 'object' || c.usage === null || Array.isArray(c.usage)) return false;
    const buckets = Object.values(c.usage as Record<string, unknown>);
    if (buckets.length === 0 || buckets.some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) return false;
  }
  return true;
}
