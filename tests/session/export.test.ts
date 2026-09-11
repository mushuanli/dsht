/** Authenticated archive downloads preserve existing files and clean up cancelled downloads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '../../src/transport/client.ts';
import { saveSessionLog } from '../../src/session/export.ts';
import { host, until } from '../support/host.ts';

test('exports the exact authenticated ZIP bytes without overwriting a local file', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const root = await mkdtemp(join(tmpdir(), 'dsht-export-')); t.after(() => rm(root, { recursive: true, force: true }));
  const client = new Client(fixture.url); t.after(() => client.close());
  await client.authenticate('fixture-token');
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 255]); fixture.exportBody = bytes;
  const path = join(root, 'session log.zip');
  assert.equal(await saveSessionLog(client, 's1', path, new AbortController().signal), path);
  assert.deepEqual(await readFile(path), bytes);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(saveSessionLog(client, 's1', path, new AbortController().signal), { code: 'EEXIST' });
  assert.equal(fixture.exportRequests, 1);
  assert.deepEqual(await readFile(path), bytes);
});

test('cancelling an archive removes only the incomplete file', async t => {
  const fixture = await host(); t.after(() => fixture.close()); fixture.exportDelayMs = 10_000;
  const root = await mkdtemp(join(tmpdir(), 'dsht-export-')); t.after(() => rm(root, { recursive: true, force: true }));
  const client = new Client(fixture.url); t.after(() => client.close());
  await client.authenticate('fixture-token');
  const existing = join(root, 'keep.zip'); await writeFile(existing, 'keep');
  const path = join(root, 'partial.zip');
  const abort = new AbortController();
  const operation = saveSessionLog(client, 's1', path, abort.signal);
  const rejected = assert.rejects(operation, { name: 'AbortError' });
  await until(() => fixture.exportRequests === 1);
  abort.abort();
  await rejected;
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal(await readFile(existing, 'utf8'), 'keep');
});
