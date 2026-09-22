/** Cookie reuse across client lifetimes, origin isolation, and invalidation behavior. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthenticationRequired, CookieStore, login } from '../../src/transport/auth.ts';
import { Client, HttpError, RemoteError } from '../../src/transport/client.ts';
import { host } from '../support/host.ts';

test('saved cookies authenticate a new client without token and remain isolated by origin', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tui-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await host(); t.after(() => fixture.close());
  const store = new CookieStore(directory);
  const first = new Client(fixture.url); t.after(() => first.close());
  await login(first, 'fixture-token', store);
  const path = join(directory, (await readdir(directory))[0]!);
  assert(!(await readFile(path, 'utf8')).includes('fixture-token'));
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await store.load('https://another-host.example'), undefined);
  const second = new Client(fixture.url); t.after(() => second.close());
  await login(second, undefined, store);
  await second.connect();
  assert.equal((await second.listWorkspaces()).length, 1);
  assert.equal(fixture.loginCount, 1);
  fixture.cookie = 'rotated';
  const third = new Client(fixture.url); t.after(() => third.close());
  await assert.rejects(login(third, undefined, store), AuthenticationRequired);
  await login(third, 'fixture-token', store);
  assert.equal(fixture.loginCount, 2);
  assert.equal(await store.load(fixture.url), 'dsh-auth-fixture=rotated');
});

test('expired cookies require login and publicly readable cookie files are rejected', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tui-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CookieStore(directory);
  await store.save('http://127.0.0.1:3080', 'dsh-auth-fixture=expired', Date.now() - 1000);
  assert.equal(await store.load('http://127.0.0.1:3080'), undefined);
  if (process.platform !== 'win32') {
    const path = join(directory, (await readdir(directory))[0]!);
    await chmod(path, 0o644);
    await assert.rejects(store.load('http://127.0.0.1:3080'), /0600/);
  }
});

for (const failure of [new HttpError(403, 'session/list'), new HttpError(500, 'session/list'),
  new RemoteError({ code: 'session/unavailable', message: 'Try later' }), new Error('Connection lost')]) {
  test(`saved-cookie ${failure.message} does not replay a startup token`, async () => {
    const store = new CookieStore('/unused');
    store.load = async () => 'dsh-auth-fixture=saved';
    const client = new Client('http://localhost');
    client.call = async () => { throw failure; };
    let exchanges = 0;
    client.authenticate = async () => { exchanges++; };
    await assert.rejects(login(client, 'must-not-be-sent', store), error => error === failure);
    assert.equal(exchanges, 0);
    await client.close();
  });
}
