/** Atomic per-session persistence for the immutable charge ledger. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ensureDirectory, listEntries, readText, removeFile, writePrivateFile } from '../storage/index.ts';
import type { Charge, SavedCost } from './types.ts';

/** Current on-disk ledger generation. Files of another generation are ignored, not migrated. */
const LEDGER_VERSION = 2;

/** Every file this unit owns: the fixed per-session name, or the `<session>-<cut>.json` it replaced. */
const OWNED_FILE = /^[0-9a-f]{64}(?:-\d+)?\.json$/;

/** The one file that holds a session's newest cut; the cut itself lives inside the file. */
function ledgerName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`;
}

/** Load every session's newest cut, leaving one fixed file per session.
 *
 * A file of another generation, a file with an unreadable shape, and a cut file superseded by the
 * newer name all describe work the next scan rebuilds, so loading removes them; the newest slice
 * of a superseded name is rewritten under the fixed one first. Files this unit does not own are
 * left where they are.
 * @param directory - Origin-scoped ledger directory, or undefined when persistence is disabled.
 * @returns The newest saved slice per session identity.
 */
export async function loadLedgers(directory: string | undefined): Promise<Map<string, SavedCost>> {
  const sessions = new Map<string, SavedCost>();
  if (!directory) return sessions;
  await ensureDirectory(directory);
  const superseded: { path: string; sessionId: string }[] = [];
  for (const name of await listEntries(directory)) {
    if (!OWNED_FILE.test(name)) continue;
    const path = join(directory, name);
    const raw = await readText(path);
    // A file removed between listing and reading is simply absent.
    if (raw === undefined) continue;
    const saved = parseLedger(raw);
    if (saved === undefined) { await removeFile(path); continue; }
    if ((sessions.get(saved.sessionId)?.cut ?? -2) <= saved.cut) sessions.set(saved.sessionId, saved);
    if (name !== ledgerName(saved.sessionId)) superseded.push({ path, sessionId: saved.sessionId });
  }
  for (const { path, sessionId } of superseded) {
    await writePrivateFile(join(directory, ledgerName(sessionId)), JSON.stringify(sessions.get(sessionId)) + '\n');
    await removeFile(path);
  }
  return sessions;
}

/** Write one session cut unless the directory already holds a newer one.
 *
 * The file is the system of record across processes, so a scan that opened an older snapshot must
 * not replace a cut another scan already persisted.
 * @param directory - Origin-scoped ledger directory.
 * @param saved - Complete slice to persist.
 * @returns Whether the directory now holds this slice.
 */
export async function saveLedger(directory: string, saved: SavedCost): Promise<boolean> {
  const path = join(directory, ledgerName(saved.sessionId));
  const existing = await readText(path);
  if (existing !== undefined && persistedCut(existing) > saved.cut) return false;
  await writePrivateFile(path, JSON.stringify(saved) + '\n');
  return true;
}

/** The cut already persisted in one file, or -1 when it holds no decision worth keeping.
 * @param raw - File contents read from the ledger directory.
 * @returns The persisted cut.
 */
function persistedCut(raw: string): number {
  try { return parseLedger(raw)?.cut ?? -1; }
  // A file of another generation or an unreadable shape carries no decision, so the new cut replaces it.
  catch { return -1; }
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
