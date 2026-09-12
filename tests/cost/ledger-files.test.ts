/** Ledger file retention: one fixed file per session, newest cut wins, dead slices are removed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLedgers, saveLedger } from '../../src/cost/ledger-files.ts';
import { CostLedger, DEFAULT_PRICES, costRecords } from '../../src/cost/index.ts';
import type { Charge, SavedCost } from '../../src/cost/index.ts';
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

/** A saved slice carrying one charge that names its own cut, so the winner is identifiable. */
function slice(sessionId: string, cut: number): SavedCost {
  const charge: Charge = { key: String(cut), provider: 'deepseek-official', model: 'deepseek-v4-flash', amount: cut };
  return { version: 2, sessionId, cut, charges: [charge] };
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

test('an older engine cannot seal its rates over a slice a newer engine decided', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const priced = (cut: number, engine: number | undefined): SavedCost => ({ version: 2, sessionId: 's1', cut, charges: [
    { key: '0', provider: 'deepseek-official', model: 'deepseek-v4-flash', amount: 2, priceId: 'flash', ...(engine === undefined ? {} : { engine }) }] });
  assert.equal(await saveLedger(directory, priced(3, 2)), true);
  // The process that loaded the old table keeps it in memory, so its newer cut arrives with no engine.
  assert.equal(await saveLedger(directory, priced(9, undefined)), false);
  assert.equal(await readFile(join(directory, name('s1')), 'utf8'), `${JSON.stringify(priced(3, 2))}\n`);
  // The same engine may still advance the slice, and so may a later one.
  assert.equal(await saveLedger(directory, priced(9, 2)), true);
  assert.equal(await saveLedger(directory, priced(10, 3)), true);
  // A slice with nothing priced cannot replace priced amounts either.
  assert.equal(await saveLedger(directory, { version: 2, sessionId: 's1', cut: 11,
    charges: [{ key: '0', provider: 'deepseek-official', model: 'deepseek-v4-flash', reason: 'no price version' }] }), false);
});

test('cut files under the replaced name migrate to the fixed name and are removed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, `${name('s1').slice(0, -5)}-2.json`), JSON.stringify(slice('s1', 2)));
  await writeFile(join(directory, `${name('s1').slice(0, -5)}-7.json`), JSON.stringify(slice('s1', 7)));

  const loaded = await loadLedgers(directory);
  assert.equal(loaded.sessions.get('s1')?.cut, 7);
  assert.deepEqual(await readdir(directory), [name('s1')]);
  assert.equal(await cutOf(join(directory, name('s1'))), 7);
});

test('an unreadable ledger is set aside and counted, a superseded cut migrates, foreign files are left', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, `${name('old').slice(0, -5)}-4.json`), JSON.stringify({ ...slice('old', 4), version: 1 }));
  await writeFile(join(directory, name('broken')), 'not a ledger');
  await writeFile(join(directory, name('s1')), JSON.stringify(slice('s1', 3)));
  await writeFile(join(directory, `${name('s1').slice(0, -5)}-1.json`), JSON.stringify(slice('s1', 1)));
  await writeFile(join(directory, 'notes.json'), '{"keep":true}');

  const loaded = await loadLedgers(directory);
  assert.deepEqual([...loaded.sessions.keys()], ['s1']);
  assert.equal(loaded.sessions.get('s1')?.cut, 3);
  // The two files this build cannot read keep their bytes under a name it never reads again.
  assert.equal(loaded.unreadable, 2);
  assert.deepEqual((await readdir(directory)).sort(),
    ['notes.json', name('s1'), `${join(directory, name('broken'))}.unreadable`.slice(directory.length + 1),
      `${join(directory, name('old')).slice(0, -5)}-4.json.unreadable`.slice(directory.length + 1)].sort());
  assert.equal(await readFile(join(directory, `${name('broken')}.unreadable`), 'utf8'), 'not a ledger');
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
