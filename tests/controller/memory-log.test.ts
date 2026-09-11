/** The runtime memory log records retained content, stays bounded and never breaks the client. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../../src/controller/index.ts';
import { historyLayout } from '../../src/session/index.ts';
import { host, until } from '../support/host.ts';

/** Start a controller on session `s1` with a memory log, and always tear both down. */
async function harness(t: Parameters<typeof test>[0] extends never ? never : { after(fn: () => void | Promise<void>): void }, path: string) {
  const fixture = await host();
  t.after(() => fixture.close());
  const controller = new Controller(fixture.url, 'fixture-token', 's1', undefined, undefined, undefined, undefined, path);
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

test('a sample reports the layout, render cache and scan counters beside the retained window', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-memory-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'memory.log');
  const { controller } = await harness(t, path);
  // Build the layout the UI builds, so its row cache is measurable rather than absent.
  const transcript = controller.state.transcript;
  historyLayout(transcript, 100);
  await controller.memoryLog!.sample();
  const sample = JSON.parse((await readFile(path, 'utf8')).trimEnd().split('\n').at(-1)!) as Record<string, unknown>;
  for (const field of ['layoutRows', 'layoutCacheBytes', 'layoutSpans', 'layoutSpanChars', 'layoutLiveWraps', 'layoutLiveMarkdown',
    'markdownEntries', 'markdownChars', 'markdownHits', 'markdownMisses', 'liveChars', 'thoughts']) {
    assert.equal(typeof sample[field], 'number', `${field} is missing from the sample`);
  }
  assert.ok(Number(sample.layoutRows) > 0, 'the built layout should be visible in the sample');
  assert.equal(typeof sample.scanning, 'boolean');
  // A forced collection is reported only on a runtime that exposes one.
  assert.equal('heapUsedAfterGc' in sample, typeof (globalThis as { gc?: () => void }).gc === 'function');
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

test('the log is absent without a path, and a write failure stops it without stopping the client', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const bare = new Controller(fixture.url, 'fixture-token');
  t.after(async () => { await bare.stop(); });
  assert.equal(bare.memoryLog, undefined);
  bare.start();
  await until(() => bare.state.online);

  const directory = await mkdtemp(join(tmpdir(), 'dsht-memory-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const blocked = join(directory, 'not-a-file');
  await mkdir(blocked);
  const { controller } = await harness(t, blocked);
  await controller.memoryLog!.sample();
  assert.ok(controller.memoryLog!.error, 'a failed write is reported on the log');
  assert.equal(controller.state.online, true);
});
