#!/usr/bin/env node
/** Standalone executable entry; connects to an existing host and never launches Harness. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CostLedger, DEFAULT_PRICES, pricesFrom } from './cost.ts';
import { parseArgs } from 'node:util';
import { render } from 'ink';
import { App } from './app.tsx';
import { sessionLabel } from './navigation.ts';
import { CookieStore, login } from './auth.ts';
import { Client } from './client.ts';
import { historyLimits } from './memory.ts';
import { Controller } from './controller.ts';
import { endpoint } from './endpoint.ts';
import { errorText, safeText, string } from './wire.ts';

const HELP = `Usage: dsht [options] [list workspaces|list sessions]

With no command, choose a workspace and session interactively.

  --url <url>           Host URL, or the dsh web URL with ?token= (DSH_URL)
  --workspace <id>      Filter list sessions by workspace
  --session <id>        Open a session directly
  --auth-dir <path>     Private cookie directory (or DSHT_AUTH_DIR)
  --history-records <n> Soft history record limit (default 2000)
  --history-mb <n>      Soft history payload budget in MiB (default 16)
  --json               Print machine-readable list output
  --help               Show this help

The default host is http://127.0.0.1:3080.
First login: export DSH_TOKEN, or export DSH_URL as the URL printed by dsh web.
Cookies are saved per server origin and reused on later starts. Tokens are never saved.
/cost shows session, today and three-day CNY estimates.
DSHT_CONFIG_DIR overrides the prices.json directory; DSHT_STATE_DIR overrides usage storage.
Examples:
  npx @itookit/dsht
  dsht list workspaces --json
  dsht list sessions --workspace <id> --json
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string', default: process.env.DSH_URL ?? 'http://127.0.0.1:3080' },
    'history-records': { type: 'string' }, 'history-mb': { type: 'string' },
    workspace: { type: 'string' }, session: { type: 'string' }, 'auth-dir': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const list = positionals[0] === 'list' && ['workspaces', 'sessions'].includes(positionals[1] ?? '') && positionals.length === 2;
  if (positionals.length && !list) throw new Error('Unknown command. Use --help.');
  if (!list && (values.json || values.workspace)) throw new Error('--json and --workspace apply to list commands');
  if (list && values.session) throw new Error('--session applies to interactive mode');
  const limits = historyLimits(values['history-records'], values['history-mb']);
  const { url, token } = endpoint(values.url, process.env.DSH_TOKEN);
  const store = new CookieStore(values['auth-dir']);
  if (list) {
    const client = new Client(url);
    try {
      await login(client, token, store);
      if (positionals[1] === 'workspaces' || values.workspace) await client.connect();
      const items = positionals[1] === 'workspaces' ? await client.listWorkspaces() : await client.listSessions(values.workspace);
      if (values.json) process.stdout.write(`${JSON.stringify({ items }, null, 2)}\n`);
      else {
        const lines = items.map(item => positionals[1] === 'workspaces'
          ? `${string(item.workspaceId)}\t${string(item.title)}\t${string(item.path)}`
          : `${string(item.sessionId)}\t${sessionLabel(item)}\t${item.running ? 'running' : 'idle'}`);
        process.stdout.write(`${safeText(lines.join('\n'))}${lines.length ? '\n' : ''}`);
      }
    } finally { await client.close(); }
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive mode requires a terminal. Use list workspaces or list sessions for scripts.');
  const config = process.env.DSHT_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dsht');
  await mkdir(config, { recursive: true, mode: 0o700 });
  const pricePath = join(config, 'prices.json');
  try { await writeFile(pricePath, JSON.stringify(DEFAULT_PRICES, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const prices = pricesFrom(JSON.parse(await readFile(pricePath, 'utf8')));
  const costDirectory = join(process.env.DSHT_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dsht'), 'cost', createHash('sha256').update(new URL(url).origin).digest('hex'));
  const costs = new CostLedger(prices, costDirectory);
  await costs.load();
  const controller = new Controller(url, token, values.session, undefined, client => login(client, token, store), costs, limits);
  const app = render(<App controller={controller} />, { exitOnCtrlC: false });
  const terminate = () => app.unmount();
  process.once('SIGTERM', terminate);
  controller.start();
  try { await app.waitUntilExit(); }
  finally { process.off('SIGTERM', terminate); await controller.shutdown(); }
}

main().catch(error => { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 1; });
