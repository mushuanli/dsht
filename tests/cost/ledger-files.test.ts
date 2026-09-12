/** Folded ledger files: one fixed file per session, newest cut wins, foreign files are left alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLedgers, saveLedger } from '../../src/cost/ledger-files.ts';
import { CostLedger, DEFAULT_PRICES, costRecords } from '../../src/cost/index.ts';
import type { SavedCost } from '../../src/cost/index.ts';
import type { ObjectValue } from '../../src/transport/wire.ts';

const at = (date: string) => Date.parse(date + '+08:00');
const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };

/** One priced request event for the given sequence. */
function record(seq: number): ObjectValue {
  return { type: 'event', event: { seq, time: at('2026-09-10T10:00:00'), type: 'assistant/message', data: { turn: 1, step: seq, usage,
    message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, content: [{ type: 'text', text: 'PRIVATE PROMPT' }] } } } };
}

/** The fixed file name this unit writes for one session identity. */
const name = (sessionId: string) => `${createHash('sha256').update(sessionId).digest('hex')}.json`;

/** A stored slice whose cut is also its amount, so the winner of a race is identifiable. */
function slice(sessionId: string, cut: number, engine = 2): SavedCost {
  const total = { amount: cut, unknown: 0, records: 1 };
  return { version: 3, sessionId, cut, engine, catalog: 'abcdef123456',
    total, day: { day: '2026-09-10', ...total }, unpriced: [] };
}

/** Read one ledger file's recorded cut. */
async function cutOf(path: string): Promise<number> {
  return (JSON.parse(await readFile(path, 'utf8')) as SavedCost).cut;
}

test('a save is refused while the directory already holds a newer cut', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await saveLedger(directory, slice('s1', 5)), true);
  assert.equal(await saveLedger(directory, slice('s1', 3)), false);
  assert.equal(await saveLedger(directory, slice('s1', 9)), true);
  assert.deepEqual(await readdir(directory), [name('s1')]);
  assert.equal(await cutOf(join(directory, name('s1'))), 9);
});

test('an older engine cannot seal its totals over a slice newer rules produced', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await saveLedger(directory, slice('s1', 3, 2)), true);
  // The process that loaded the older rules keeps them in memory, so its newer cut arrives with them.
  assert.equal(await saveLedger(directory, slice('s1', 9, 1)), false);
  assert.equal(await readFile(join(directory, name('s1')), 'utf8'), `${JSON.stringify(slice('s1', 3, 2))}\n`);
  // The same rules may still advance the slice, and so may a later revision.
  assert.equal(await saveLedger(directory, slice('s1', 9, 2)), true);
  assert.equal(await saveLedger(directory, slice('s1', 10, 3)), true);
});

test('a file of another generation is ignored and foreign files are left where they are', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, name('old')), JSON.stringify({ version: 2, sessionId: 'old', cut: 4, charges: [] }));
  await writeFile(join(directory, name('broken')), 'not a ledger');
  await writeFile(join(directory, name('s1')), JSON.stringify(slice('s1', 3)));
  await writeFile(join(directory, 'notes.json'), '{"keep":true}');

  const loaded = await loadLedgers(directory);
  assert.deepEqual([...loaded.keys()], ['s1']);
  assert.equal(loaded.get('s1')?.cut, 3);
  // A slice this build cannot use costs the next scan a rescan, not data, so nothing is renamed.
  assert.deepEqual((await readdir(directory)).sort(), ['notes.json', name('broken'), name('old'), name('s1')].sort());
});

test('a stale scan keeps its own slice and cannot rewrite a newer persisted cut', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const one = costRecords([record(0)]);
  const two = costRecords([record(0), record(1)]);
  const stale = new CostLedger(DEFAULT_PRICES, directory); await stale.load();
  await stale.replace('s1', 5, one);
  const newer = new CostLedger(DEFAULT_PRICES, directory); await newer.load();
  await newer.replace('s1', 9, two);
  assert.equal(newer.total('s1').records, 2);

  await stale.replace('s1', 5, one);
  assert.deepEqual(await readdir(directory), [name('s1')]);
  assert.equal(await cutOf(join(directory, name('s1'))), 9);
  const restarted = new CostLedger(DEFAULT_PRICES, directory); await restarted.load();
  assert.equal(restarted.total('s1').records, 2);
  // The refused write also leaves the stale process's own view untouched.
  assert.equal(stale.total('s1').records, 1);
});
