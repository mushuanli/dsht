/** Folded ledger files: one fixed file per session, newest cut wins, foreign files are left alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLedgers, saveLedger } from '../../src/cost/ledger-files.ts';
import { CostLedger, costDayStart, costDaysBefore, costRecords, costWindowStart, DEFAULT_PRICES } from '../../src/cost/index.ts';
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
function slice(sessionId: string, cut: number, engine = 2, days = ['2026-09-10']): SavedCost {
  const total = { amount: cut, unknown: 0, records: 1 };
  return { version: 4, sessionId, cut, engine, catalog: 'abcdef123456',
    total, days: days.map(day => ({ day, ...total })), unpriced: [] };
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
  await writeFile(join(directory, name('old')), JSON.stringify({ version: 3, sessionId: 'old', cut: 4, day: { day: '2026-09-10', amount: 1, unknown: 0, records: 1 } }));
  await writeFile(join(directory, name('broken')), 'not a ledger');
  // A slice of this generation whose shape is wrong is skipped too: the host log rebuilds it, so a
  // corrupt file costs a rescan and must never stop the client that is starting up.
  await writeFile(join(directory, name('wrong')), JSON.stringify({ ...slice('wrong', 4), days: 'not a list' }));
  await writeFile(join(directory, name('s1')), JSON.stringify(slice('s1', 3)));
  await writeFile(join(directory, 'notes.json'), '{"keep":true}');

  const loaded = await loadLedgers(directory);
  assert.deepEqual([...loaded.keys()], ['s1']);
  assert.equal(loaded.get('s1')?.cut, 3);
  // A slice this build cannot use costs the next scan a rescan, not data, so nothing is renamed.
  assert.deepEqual((await readdir(directory)).sort(), ['notes.json', name('broken'), name('old'), name('s1'), name('wrong')].sort());
});

test('a slice whose days all left the window is deleted, and one still inside it is kept', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  // The window is measured from the clock the load is given, so the boundary is the test's to name.
  const now = at('2026-09-24T12:00:00');
  const floor = costWindowStart(now);
  await writeFile(join(directory, name('fresh')), JSON.stringify(slice('fresh', 1, 2, [floor])));
  await writeFile(join(directory, name('stale')), JSON.stringify(slice('stale', 1, 2, [costDaysBefore(floor, 1)])));
  await writeFile(join(directory, name('multi')), JSON.stringify(slice('multi', 1, 2, [costDaysBefore(floor, 5), floor])));

  const ledger = new CostLedger(DEFAULT_PRICES, directory);
  await ledger.load(now);
  // The newest day decides, and the boundary day itself is still inside: a session that spent
  // anything within the window keeps its whole slice, days older than the window included.
  assert.equal(ledger.hasSession('fresh'), true);
  assert.equal(ledger.hasSession('multi'), true);
  assert.equal(ledger.hasSession('stale'), false);
  assert.deepEqual((await readdir(directory)).sort(), [name('fresh'), name('multi')].sort());
});

test('a slice with no days at all is not kept', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, name('empty')), JSON.stringify(slice('empty', 0, 2, [])));
  const ledger = new CostLedger(DEFAULT_PRICES, directory);
  await ledger.load(at('2026-09-24T12:00:00'));
  assert.equal(ledger.hasSession('empty'), false);
  assert.deepEqual(await readdir(directory), []);
});

test('a file this build cannot read still ages out once it is older than the window', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const now = at('2026-09-24T12:00:00');
  const floor = costWindowStart(now);
  // Neither of these is loaded — one is an older generation, one is malformed — so only a file's own
  // age can collect them. A freshly written one of the same kind is kept until it ages out too.
  const dead = join(directory, name('dead'));
  await writeFile(dead, JSON.stringify({ version: 3, sessionId: 'dead', cut: 1, day: { day: costDaysBefore(floor, 1) } }));
  const broken = join(directory, name('broken'));
  await writeFile(broken, 'not a ledger');
  await writeFile(join(directory, name('fresh')), 'not a ledger either');
  const old = new Date(costDayStart(costDaysBefore(floor, 1)));
  await utimes(dead, old, old);
  await utimes(broken, old, old);

  const ledger = new CostLedger(DEFAULT_PRICES, directory);
  await ledger.load(now);
  assert.equal(ledger.hasSession('dead'), false);
  assert.deepEqual(await readdir(directory), [name('fresh')]);
});

test('a state directory that cannot be written still loads, keeping what it could not delete', async t => {
  // Windows and root ignore the directory mode, so the failure this pins cannot be reproduced there.
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-'));
  t.after(async () => { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }); });
  const now = at('2026-09-24T12:00:00');
  await writeFile(join(directory, name('stale')), JSON.stringify(slice('stale', 1, 2, [costDaysBefore(costWindowStart(now), 1)])));
  await chmod(directory, 0o500);

  // Retention is housekeeping: a state directory that rejects the delete costs a stale file, never a
  // start, and the slice it could not remove is still reported for as long as it is there.
  const ledger = new CostLedger(DEFAULT_PRICES, directory);
  await ledger.load(now);
  assert.equal(ledger.hasSession('stale'), true);
  assert.deepEqual(await readdir(directory), [name('stale')]);
});

test('a stale scan keeps its own slice and cannot rewrite a newer persisted cut', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const one = costRecords([record(0)]);
  const two = costRecords([record(0), record(1)]);
  // Every load is pinned to the fixture's own day, so the retention pass judges the slice by the
  // clock the events were written against rather than by whenever the suite happens to run.
  const clock = () => at('2026-09-10T12:00:00');
  const stale = new CostLedger(DEFAULT_PRICES, directory); await stale.load(clock());
  await stale.replace('s1', 5, one);
  const newer = new CostLedger(DEFAULT_PRICES, directory); await newer.load(clock());
  await newer.replace('s1', 9, two);
  assert.equal(newer.total('s1').records, 2);

  await stale.replace('s1', 5, one);
  assert.deepEqual(await readdir(directory), [name('s1')]);
  assert.equal(await cutOf(join(directory, name('s1'))), 9);
  const restarted = new CostLedger(DEFAULT_PRICES, directory); await restarted.load(clock());
  assert.equal(restarted.total('s1').records, 2);
  // The refused write also leaves the stale process's own view untouched.
  assert.equal(stale.total('s1').records, 1);
});
