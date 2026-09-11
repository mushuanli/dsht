/** The runtime memory log records retained content, stays bounded and never breaks the client. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../../src/controller/index.ts';
import { host, until } from '../support/host.ts';

async function harness(t: { after(fn: () => Promise<void>): void }, path: string, ledger?: undefined) {
  const fixture = await host();
  t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, ledger, undefined, path);
  t.after(async () => { await controller.stop(); });
  controller.start();
  await until(() => controller.state.transcript.ready);
  return { fixture, controller };
}

test('a memory sample records the reclamation state and appends one bounded line', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-memory-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'memory.log');
  const { controller } = await harness(t, path);
  controller.pinHistory(true);
  await controller.memoryLog!.sample();
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
  assert.match(lines[0]!, /^# dsht memory samples/);
  const sample = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  assert.equal(sample.pinned, true);
  assert.equal(sample.online, true);
  assert.equal(sample.session, 's1');
  assert.equal(sample.screen, 'chat');
  assert.equal(sample.records, 1);
  assert.equal(sample.hasMore, false);
  assert.equal(sample.pending, 0);
  assert.equal(typeof sample.retainedBytes, 'number');
  assert.ok(Number(sample.rss) > 0 && Number(sample.heapUsed) > 0);
  assert.ok(!('ledgerCharges' in sample));
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('the log rewrites itself so a long run keeps only the newest samples', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-memory-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'memory.log');
  const { controller } = await harness(t, path);
  for (let index = 0; index < 1005; index++) await controller.memoryLog!.sample();
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
  assert.ok(lines.length >= 1000 && lines.length <= 1006, `unexpected line count ${lines.length}`);
  assert.match(lines[0]!, /^# dsht memory samples/);
  assert.equal((JSON.parse(lines.at(-1)!) as { records: number }).records, 1);
});

test('the log is absent without a path and stops itself after a write failure', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const bare = new Controller(fixture.url, 'fixture-token');
  assert.equal(bare.memoryLog, undefined);
  bare.start();
  await until(() => bare.state.transcript.ready);
  await bare.stop();

  const directory = await mkdtemp(join(tmpdir(), 'dsht-memory-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const blocked = join(directory, 'not-a-file');
  await mkdir(blocked);
  const { controller } = await harness(t, blocked);
  await controller.memoryLog!.sample();
  assert.ok(controller.memoryLog!.error, 'a failed write is reported on the log');
  assert.equal(controller.state.online, true);
});
