/** Price-configuration seeding and the superseded-seed migration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PRICES, PRICES_REVISION, isUncorrectedSeed, loadPrices, pricesFrom } from '../../src/cost/index.ts';

/** The table shipped before the Flash rates were corrected, as it reached disk. */
const SUPERSEDED = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'].map(model => {
  const scale = model === 'deepseek-v4-pro' ? 3 : 1;
  return { id: `deepseek-2026-09-10-${model}`, provider: 'deepseek-official', model,
    from: '2026-09-10T00:00:00+08:00', currency: 'CNY' as const, source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    timezone: 'Asia/Shanghai', peak: { input: 3 * scale, cacheRead: 0.1 * scale, cacheWrite: 3 * scale, output: 9 * scale },
    offPeak: { input: 1.5 * scale, cacheRead: 0.05 * scale, cacheWrite: 1.5 * scale, output: 4.5 * scale },
    weekdays: [1, 2, 3, 4, 5], windows: [[540, 720], [840, 1080]] as [number, number][] };
});

/** Run one case against a fresh private configuration directory. */
async function inConfig(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prices-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a first run seeds the shipped table and marks it as the tool own copy', async () => {
  await inConfig(async directory => {
    const { prices, custom } = await loadPrices(directory);
    assert.equal(custom, false);
    assert.deepEqual(prices, DEFAULT_PRICES);
    const written = await readFile(join(directory, 'prices.json'), 'utf8');
    assert.deepEqual(pricesFrom(JSON.parse(written)), DEFAULT_PRICES);
    const stamp = JSON.parse(await readFile(join(directory, 'prices.seed.json'), 'utf8'));
    assert.equal(stamp.revision, PRICES_REVISION);
    assert.match(stamp.hash, /^[0-9a-f]{64}$/);
  });
});

test('an unedited seed follows a corrected shipped table, and an edit makes the file authoritative', async () => {
  await inConfig(async directory => {
    const first = pricesFrom(DEFAULT_PRICES.map(price => ({ ...price, peak: { ...price.peak, input: 3 } })));
    await loadPrices(directory, first);
    // The file still hashes to the stamp, so a build that ships corrected rates replaces it.
    const refreshed = await loadPrices(directory, DEFAULT_PRICES);
    assert.equal(refreshed.custom, false);
    assert.deepEqual(refreshed.prices, DEFAULT_PRICES);
    assert.deepEqual(pricesFrom(JSON.parse(await readFile(join(directory, 'prices.json'), 'utf8'))), DEFAULT_PRICES);
    // Once the user edits the file, the tool leaves their rates alone and says so.
    const edited = `${JSON.stringify([{ ...DEFAULT_PRICES[0]!, peak: { ...DEFAULT_PRICES[0]!.peak, input: 7 } }], null, 2)}\n`;
    await writeFile(join(directory, 'prices.json'), edited);
    const custom = await loadPrices(directory, DEFAULT_PRICES);
    assert.equal(custom.custom, true);
    assert.equal(custom.prices[0]!.peak.input, 7);
    assert.equal(await readFile(join(directory, 'prices.json'), 'utf8'), edited);
  });
});

test('an unchanged seed needs no write, so a read-only configuration directory still starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-prices-'));
  try {
    await loadPrices(directory);
    await chmod(directory, 0o500);
    const again = await loadPrices(directory);
    assert.equal(again.custom, false);
    assert.deepEqual(again.prices, DEFAULT_PRICES);
  } finally { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); }
});

test('the superseded seed is recognized and replaced, and any other unstamped table is left alone', async () => {
  await inConfig(async directory => {
    assert.equal(isUncorrectedSeed(pricesFrom(SUPERSEDED)), true);
    assert.equal(isUncorrectedSeed(DEFAULT_PRICES), false);
    await writeFile(join(directory, 'prices.json'), `${JSON.stringify(SUPERSEDED, null, 2)}\n`);
    const migrated = await loadPrices(directory);
    assert.equal(migrated.custom, false);
    assert.deepEqual(migrated.prices, DEFAULT_PRICES);
    // A table the user wrote by hand is not the seed, so it survives without a stamp.
    const handWritten = `${JSON.stringify([{ ...DEFAULT_PRICES[0]!, peak: { ...DEFAULT_PRICES[0]!.peak, input: 1.25 } }], null, 2)}\n`;
    await writeFile(join(directory, 'prices.json'), handWritten);
    const kept = await loadPrices(directory);
    assert.equal(kept.custom, true);
    assert.equal(kept.prices[0]!.peak.input, 1.25);
  });
});
