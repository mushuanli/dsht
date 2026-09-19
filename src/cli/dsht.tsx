#!/usr/bin/env node
/** Standalone executable entry; connects to an existing host and never launches Harness. */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CostLedger, loadPrices } from '../cost/index.ts';
import { parseArgs } from 'node:util';
import { mount } from '../ui/mount.tsx';
import { ensureDirectory } from '../storage/index.ts';
import { runStartup } from './startup.ts';
import { sessionLabel } from '../session-title.ts';
import { CookieStore, login } from '../transport/auth.ts';
import { Client } from '../transport/client.ts';
import { fileURLToPath } from 'node:url';
import { historyLimits } from '../session/memory.ts';
import { ProcessVerifier } from './verifier.ts';
import type { VerifierPort } from '../controller/verifier.ts';
import { Controller } from '../controller/controller.ts';
import { endpoint } from '../transport/endpoint.ts';
import { errorText, string } from '../transport/wire.ts';
import { safeText } from '../text.ts';

const HELP = `Usage: dsht [options] [list workspaces|list sessions]

With no command, choose a workspace and session interactively.

  --url <url>           Host URL, or the dsh web URL with ?token= (DSH_URL)
  --workspace <id>      Filter list sessions by workspace
  --session <id|new>    Open a session directly, or create one
  --ws <id|name|path>   Select this workspace at startup (default: this directory)
  --command <line>      Run this slash command once the session is ready (repeatable)
  --prompt <text>       Send this plain prompt once the session is ready
  --wait                With --headless, exit when the sent prompt's turn has finished
  --verdict <path>      With --prompt/--wait, write the reply's verdict to this file
  --verdict-identity <id>  <runId>/<kind>/<step>/<attempt> the verdict must declare
  --headless            Run --command without the terminal interface, then exit
  --auth-dir <path>     Private cookie directory (or DSHT_AUTH_DIR)
  --history-records <n> Soft history record limit (default 2000)
  --history-mb <n>      Soft history payload budget in MiB (default 16)
  --memory-log <path>   Append runtime memory samples; a failing log stops itself
  --trace <path>        Append connection/screen/selection events (default: <state>/trace.log)
  --no-trace            Disable the transition trace
  --no-memory-log       Disable the runtime memory log (default: enabled)
  --no-shell            Disable ! local commands (DSHT_NO_SHELL=1)
  --json               Print machine-readable list output
  --help               Show this help

The default host is http://127.0.0.1:3080.
First login: export DSH_TOKEN, or export DSH_URL as the URL printed by dsh web.
Cookies are saved per server origin and reused on later starts. Tokens are never saved.
/cost shows the session and today CNY estimates.
/prompt lists saved shortcut prompts; /prompt TEXT saves one in <state>/prompts.json.
!command runs on this machine, not on the host, and prints its output in the transcript.
DSHT_CONFIG_DIR overrides the prices.json directory; DSHT_STATE_DIR overrides usage storage.
The transition trace defaults to <state>/trace.log; DSHT_TRACE sets another path or 'off'.
The memory log defaults to <state>/memory.log; DSHT_MEMORY_LOG sets another path or 'off'.
prices.json overrides the shipped rates and is seeded on first use; every scan re-decides the
history with the table loaded then, so an edited table reaches past requests on the next scan.
Examples:
  npx @itookit/dsht
  dsht list workspaces --json
  dsht list sessions --workspace <id> --json
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string', default: process.env.DSH_URL ?? 'http://127.0.0.1:3080' },
    'history-records': { type: 'string' }, 'history-mb': { type: 'string' },
    workspace: { type: 'string' }, ws: { type: 'string' }, session: { type: 'string' }, 'auth-dir': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
    command: { type: 'string', multiple: true }, prompt: { type: 'string' }, wait: { type: 'boolean' },
    verdict: { type: 'string' }, 'verdict-identity': { type: 'string' }, headless: { type: 'boolean' },
    trace: { type: 'string' }, 'no-trace': { type: 'boolean' },
    'memory-log': { type: 'string' }, 'no-memory-log': { type: 'boolean' }, 'no-shell': { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const list = positionals[0] === 'list' && ['workspaces', 'sessions'].includes(positionals[1] ?? '') && positionals.length === 2;
  if (positionals.length && !list) throw new Error('Unknown command. Use --help.');
  if (!list && (values.json || values.workspace)) throw new Error('--json and --workspace apply to list commands');
  if (list && values.session) throw new Error('--session applies to interactive mode');
  if (list && (values.ws || values.command?.length || values.prompt !== undefined || values.wait || values.headless)) {
    throw new Error('--ws, --command, --prompt, --wait and --headless apply to interactive mode');
  }
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
  const config = process.env.DSHT_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dsht');
  await ensureDirectory(config);
  const { prices, custom } = await loadPrices(config);
  const stateRoot = process.env.DSHT_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dsht');
  const costDirectory = join(stateRoot, 'cost', createHash('sha256').update(new URL(url).origin).digest('hex'));
  const costs = new CostLedger(prices, costDirectory, custom);
  await costs.load();
  if (!values.headless && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Interactive mode requires a terminal. Use --headless or list workspaces/list sessions for scripts.');
  }
  const shellEnabled = !values['no-shell'] && process.env.DSHT_NO_SHELL !== '1';
  const localDirectory = process.cwd();
  // A scored review can delegate each round's verdict to a child client, which needs no shared state
  // with this one: it is handed a session and a prompt, and answers through a file.
  const verifier: VerifierPort | undefined = process.env.DSHT_NO_VERIFY === '1' ? undefined : new ProcessVerifier({
    command: [process.execPath, ...process.execArgv, process.argv[1] ?? fileURLToPath(import.meta.url)],
    url: values.url,
    ...(values['auth-dir'] === undefined ? {} : { authDir: values['auth-dir'] }),
    directory: localDirectory, cwd: localDirectory, env: process.env,
    timeoutMs: verifyTimeoutMs(process.env.DSHT_VERIFY_TIMEOUT_MS),
    createSession: (title: string): Promise<string | undefined> => controller.actions.createVerifierSession(title),
    cancelSession: async (sessionId: string): Promise<void> => { await controller.actions.cancelVerifierSession(sessionId); },
    onLine: line => { if (values.headless) log(line); },
  });
  const controller = new Controller({
    base: url, token, initialSession: values.session === 'new' ? undefined : values.session,
    authenticate: client => login(client, token, store),
    localDirectory, verifier,
    // Verdicts belong to this client rather than to the reviewed tree, and the client's own
    // directory is the one place it is always allowed to write; DSHT_VERDICT_ROOT points them
    // elsewhere when the review targets a workspace this machine cannot write.
    verdictRoot: process.env.DSHT_VERDICT_ROOT ?? localDirectory,
    costs, historyLimits: limits, shellEnabled,
    tracePath: tracePath(stateRoot, values.trace, values['no-trace']),
    memoryLogPath: memoryLogPath(stateRoot, values['memory-log'], values['no-memory-log']),
    promptsPath: join(stateRoot, 'prompts.json'),
  });
  const plan = {
    ...(values.ws === undefined ? {} : { workspace: values.ws }),
    ...(values.session === undefined ? {} : { session: values.session }),
    commands: values.command ?? [],
    ...(values.prompt === undefined ? {} : { prompt: values.prompt }),
    ...(values.wait === undefined ? {} : { wait: values.wait }),
    ...(values.verdict === undefined ? {} : { verdict: { file: values.verdict, identity: requireIdentity(values['verdict-identity']) } }),
    timeoutSeconds: 3600,
  };
  const log = (line: string) => process.stderr.write(`${line}\n`);
  controller.start();
  if (values.headless) {
    // No renderer: run the plan, follow a started loop to its verdict, and report it as the exit code.
    try { process.exitCode = await runStartup(controller, plan, log) === 'failed' ? 1 : 0; }
    finally { await controller.shutdown(); }
    return;
  }
  const app = mount(controller);
  const terminate = () => app.unmount();
  process.once('SIGTERM', terminate);
  void runStartup(controller, plan, log).catch(error => process.stderr.write(`${errorText(error)}\n`));
  try { await app.waitUntilExit(); }
  finally { process.off('SIGTERM', terminate); await controller.shutdown(); }
}

/** The identity a written verdict must declare, refused when the flag that carries it is missing.
 * @param value - `--verdict-identity` value.
 * @returns The identity.
 */
function requireIdentity(value: string | undefined): string {
  if (value === undefined || value.trim() === '') throw new Error('--verdict requires --verdict-identity');
  return value;
}

/** How long one forked verification may run, from a minute count in the environment.
 * @param value - `DSHT_VERIFY_TIMEOUT_MS` when set.
 * @returns The timeout in milliseconds, defaulting to twenty minutes.
 */
function verifyTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20 * 60_000;
}

/** Resolve the runtime memory log path: an explicit flag wins, then the environment, then the default.
 * @param stateRoot - Application state root used for the default path.
 * @param requested - `--memory-log` value, when given.
 * @param disabled - `--no-memory-log` flag.
 * @returns Absolute log path, or undefined when the log is disabled.
 */
function memoryLogPath(stateRoot: string, requested: string | undefined, disabled: boolean | undefined): string | undefined {
  return diagnosticLogPath('memory-log', 'memory.log', stateRoot, requested, disabled, process.env.DSHT_MEMORY_LOG);
}

/** Resolve the transition trace path: an explicit flag wins, then the environment, then the default.
 * @param stateRoot - Application state root used for the default path.
 * @param requested - `--trace` value, when given.
 * @param disabled - `--no-trace` flag.
 * @returns Absolute trace path, or undefined when the trace is disabled.
 */
function tracePath(stateRoot: string, requested: string | undefined, disabled: boolean | undefined): string | undefined {
  return diagnosticLogPath('trace', 'trace.log', stateRoot, requested, disabled, process.env.DSHT_TRACE);
}

/** Resolve one diagnostic log path shared by the memory log and the transition trace.
 * @param flag - Long option name, used in the error for an empty value.
 * @param file - Default filename under the state root.
 * @param stateRoot - Application state root.
 * @param requested - Flag value, when given; an empty string is a mistyped flag, not a default.
 * @param disabled - `--no-<flag>` flag.
 * @param environment - Environment override, where `off` disables the log.
 * @returns Absolute log path, or undefined when the log is disabled.
 */
function diagnosticLogPath(flag: string, file: string, stateRoot: string, requested: string | undefined,
  disabled: boolean | undefined, environment: string | undefined): string | undefined {
  if (requested !== undefined && requested.trim() === '') throw new Error(`--${flag} requires a path`);
  if (disabled) return undefined;
  const chosen = (requested ?? environment)?.trim();
  if (chosen === undefined || chosen === '') return join(stateRoot, file);
  return chosen === 'off' ? undefined : chosen;
}

main().catch(error => { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 1; });
