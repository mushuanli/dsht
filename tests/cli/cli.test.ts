/** Exercise the executable source entry as an external client process. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { host } from '../support/host.ts';

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const authDirectory = await mkdtemp(join(tmpdir(), 'tui-cli-auth-'));
  // The entry reads configuration, state and a loop overlay while starting up, and prunes the cost
  // ledger as it loads it. Every run therefore gets its own directories and a URL nothing listens on,
  // so a test can neither read nor delete the real install, nor reach whatever host happens to be
  // running on the default port.
  const stateDirectory = await mkdtemp(join(tmpdir(), 'tui-cli-state-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'tui-cli-config-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: new URL('../..', import.meta.url),
    env: { PATH: process.env.PATH, DSH_URL: 'http://127.0.0.1:1', DSHT_AUTH_DIR: authDirectory,
      DSHT_STATE_DIR: stateDirectory, DSHT_CONFIG_DIR: configDirectory, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
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
  } finally {
    clearTimeout(timer);
    await rm(authDirectory, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(configDirectory, { recursive: true, force: true });
  }
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
  assert.match(help.stdout, /--deadline <minutes>/);
  assert.match(help.stdout, /--version/);
  const invalid = await run(['wrong'], { DSH_TOKEN: 'private-token' });
  assert.equal(invalid.code, 1);
  assert(!invalid.stderr.includes('private-token'));
  const missing = await run(['list', 'sessions']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /DSH_TOKEN/);
  // A run that was supposed to be bounded must not start unbounded because of a typo.
  const deadline = await run(['--headless', '--deadline', '0', '--command', '/status'], { DSH_TOKEN: 'fixture-token' });
  assert.equal(deadline.code, 1);
  assert.match(deadline.stderr, /--deadline must be a positive number of minutes/);
});

test('--version prints the manifest version without a host or credentials', async () => {
  const printed = await run(['--version']);
  assert.equal(printed.code, 0, printed.stderr);
  assert.equal(printed.stderr, '');
  // The manifest is the only place the version lives, so the flag has to agree with it exactly.
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(printed.stdout.trim(), manifest.version);
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
