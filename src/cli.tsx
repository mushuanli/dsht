/** Standalone executable entry; connects to an existing host and never launches Harness. */
import { parseArgs } from 'node:util';
import { render } from 'ink';
import { App, sessionLabel } from './app.tsx';
import { Client } from './client.ts';
import { Controller } from './controller.ts';
import { errorText, safeText, string } from './wire.ts';

const HELP = `Usage: npm start -- [options] [list workspaces|list sessions]

With no command, choose a workspace and session interactively.

  --url <origin>        Host origin (DSH_URL or http://127.0.0.1:3080)
  --workspace <id>      Filter list sessions by workspace
  --session <id>        Open a session directly
  --json               Print machine-readable list output
  --help               Show this help

Set DSH_TOKEN to the token printed by dsh web. Tokens and cookies are not saved.
Examples:
  npm start
  npm start -- list workspaces --json
  npm start -- list sessions --workspace <id> --json
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string', default: process.env.DSH_URL ?? 'http://127.0.0.1:3080' },
    workspace: { type: 'string' }, session: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const list = positionals[0] === 'list' && ['workspaces', 'sessions'].includes(positionals[1] ?? '') && positionals.length === 2;
  if (positionals.length && !list) throw new Error('Unknown command. Use --help.');
  if (!list && (values.json || values.workspace)) throw new Error('--json and --workspace apply to list commands');
  if (list && values.session) throw new Error('--session applies to interactive mode');
  const token = process.env.DSH_TOKEN;
  if (!token) throw new Error('Set DSH_TOKEN to the startup token printed by dsh web');
  if (list) {
    const client = new Client(values.url);
    try {
      await client.authenticate(token);
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
  const controller = new Controller(values.url, token, values.session);
  const app = render(<App controller={controller} />);
  const terminate = () => app.unmount();
  process.once('SIGTERM', terminate);
  controller.start();
  try { await app.waitUntilExit(); }
  finally { process.off('SIGTERM', terminate); await controller.stop(); }
}

main().catch(error => { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 1; });
