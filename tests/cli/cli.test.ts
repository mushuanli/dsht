/** Exercise the executable source entry as an external client process. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { host } from '../support/host.ts';

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const authDirectory = await mkdtemp(join(tmpdir(), 'tui-cli-auth-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.tsx', ...args], {
    cwd: new URL('../..', import.meta.url),
    env: { PATH: process.env.PATH, DSHT_AUTH_DIR: authDirectory, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => signal ? reject(new Error(`CLI killed by ${signal}`)) : resolve(code));
    });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); await rm(authDirectory, { recursive: true, force: true }); }
}

test('list commands print parseable JSON and exit without opening a TUI', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const authDirectory = await mkdtemp(join(tmpdir(), 'tui-cli-saved-'));
  t.after(() => rm(authDirectory, { recursive: true, force: true }));
  const env = { DSH_TOKEN: 'fixture-token', DSH_URL: fixture.url, DSHT_AUTH_DIR: authDirectory };
  const workspaces = await run(['list', 'workspaces', '--json'], env);
  assert.equal(workspaces.code, 0, workspaces.stderr);
  assert.equal(JSON.parse(workspaces.stdout).items[0].workspaceId, 'w1');
  const sessions = await run(['list', 'sessions', '--workspace', 'w1', '--json'], { ...env, DSH_TOKEN: undefined });
  assert.equal(sessions.code, 0, sessions.stderr);
  assert.deepEqual(JSON.parse(sessions.stdout).items.map((item: { sessionId: string }) => item.sessionId), ['s1']);
  assert.equal(fixture.loginCount, 1);
});

test('help requires no token and invalid commands fail without exposing the token', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /list workspaces/);
  const invalid = await run(['wrong'], { DSH_TOKEN: 'private-token' });
  assert.equal(invalid.code, 1);
  assert(!invalid.stderr.includes('private-token'));
  const missing = await run(['list', 'sessions']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /DSH_TOKEN/);
});

test('the URL printed by dsh web authenticates without DSH_TOKEN', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const authenticated = await run(['list', 'workspaces', '--json'], { DSH_URL: `${fixture.url}/?token=fixture-token` });
  assert.equal(authenticated.code, 0, authenticated.stderr);
  assert.equal(JSON.parse(authenticated.stdout).items[0].workspaceId, 'w1');
  assert.equal(fixture.loginCount, 1);
  const precedence = await run(['list', 'sessions', '--json'], { DSH_URL: `${fixture.url}/?token=stale`, DSH_TOKEN: 'fixture-token' });
  assert.equal(precedence.code, 0, precedence.stderr);
  const extra = await run(['list', 'workspaces', '--json'], { DSH_URL: `${fixture.url}/?token=fixture-token&x=1` });
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /origin/);
  assert(!extra.stderr.includes('fixture-token'));
});
