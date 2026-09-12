/** Seed, migrate and load the price configuration that overrides the shipped table. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createPrivateFile, readText, writePrivateFile } from '../storage/index.ts';
import { DEFAULT_PRICES, PRICES_REVISION, isUncorrectedSeed, pricesFrom } from './pricing.ts';
import type { PriceVersion } from './types.ts';

/** Bytes the tool seeded, so a file the user never edited can follow a corrected shipped table. */
interface SeedStamp { revision: string; hash: string }

/** Load the price table, seeding the file on first use and refreshing a copy the user never edited.
 *
 * `prices.json` overrides the shipped table, so a correction to the shipped rates would otherwise
 * never reach an install that already had the file — which is how a superseded Flash table kept
 * charging 1.5x for input after it was fixed. The stamp records the seeded bytes: while the file
 * still hashes to them the tool owns it and follows the shipped table, and the first edit makes the
 * file authoritative, so no rate the user chose is ever overwritten.
 * @param directory - Configuration directory holding `prices.json`.
 * @param shipped - Table this build ships, seeded on first use and followed while the file is untouched.
 * @returns The validated table, and whether it came from a file the user maintains.
 * @throws when the file exists but is not a valid table.
 */
export async function loadPrices(directory: string, shipped: PriceVersion[] = DEFAULT_PRICES): Promise<{ prices: PriceVersion[]; custom: boolean }> {
  const path = join(directory, 'prices.json');
  const stampPath = join(directory, 'prices.seed.json');
  const seeded = `${JSON.stringify(shipped, null, 2)}\n`;
  const raw = await readText(path);
  if (raw === undefined) {
    await createPrivateFile(path, seeded);
    await writePrivateFile(stampPath, stamp(seeded));
    return { prices: shipped, custom: false };
  }
  const prices = pricesFrom(JSON.parse(raw));
  const recorded = await readStamp(stampPath);
  // A file without a stamp predates the record; only the superseded shipped seed is recognized there,
  // because anything else may be a table the user wrote by hand.
  const owned = recorded === undefined ? isUncorrectedSeed(prices) : recorded === hash(raw);
  if (!owned) return { prices, custom: true };
  // Write only what a corrected table actually changed, so an unchanged file needs no write at all
  // and a read-only configuration directory still starts.
  if (raw !== seeded) await writePrivateFile(path, seeded);
  if (recorded !== hash(seeded)) await writePrivateFile(stampPath, stamp(seeded));
  return { prices: shipped, custom: false };
}

/** Sha256 of one file's contents.
 * @param contents - Exact file text.
 * @returns Lowercase hex digest.
 */
function hash(contents: string): string { return createHash('sha256').update(contents).digest('hex'); }

/** Serialize the stamp written beside a seeded table.
 * @param contents - Exact seeded text.
 * @returns Stamp file contents.
 */
function stamp(contents: string): string { return `${JSON.stringify({ revision: PRICES_REVISION, hash: hash(contents) }, null, 2)}\n`; }

/** Read the seed stamp, tolerating a stamp written by another revision.
 * @param path - Stamp file path.
 * @returns The digest recorded for the seeded file, or undefined when no stamp applies.
 */
async function readStamp(path: string): Promise<string | undefined> {
  const raw = await readText(path);
  if (raw === undefined) return;
  try {
    const parsed = JSON.parse(raw) as Partial<SeedStamp>;
    return typeof parsed.hash === 'string' ? parsed.hash : undefined;
  } catch { return undefined; }
}
