#!/usr/bin/env node
/** Standalone executable entry; connects to an existing host and never launches Harness. */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CostLedger, loadPrices } from '../cost/index.ts';
import { parseArgs } from 'node:util';
import { mount } from '../ui/mount.tsx';
import { ensureDirectory, readText } from '../storage/index.ts';
import { runStartup } from './startup.ts';
import { sessionLabel } from '../session-title.ts';
import { CookieStore, login } from '../transport/auth.ts';
import { Client } from '../transport/client.ts';
import { fileURLToPath } from 'node:url';
import { historyLimits } from '../session/memory.ts';
import { ProcessVerifier } from './verifier.ts';
import type { VerifierPort } from '../controller/verifier.ts';
import { Controller } from '../controller/controller.ts';
import { loadLoopSource } from '../controller/loop-source.ts';
import { installLoopSource } from '../controller/loop-prompts.ts';
import { endpoint } from '../transport/endpoint.ts';
import { errorText, object, string } from '../transport/wire.ts';
import { formatTraceSummary, summarizeTrace } from './trace-summary.ts';
import { safeText } from '../text.ts';

const HELP = `Usage: dsht [options] [list workspaces|list sessions|trace]

With no command, choose a workspace and session interactively.

  --url <url>           Host URL, or the dsh web URL with ?token= (DSH_URL)
  --workspace <id>      Filter list sessions by workspace
  --session <id|new>    Open a session directly, or create one
  --ws <id|name|path>   Select this workspace at startup (default: this directory)
  --command <line>      Run this slash command once the session is ready (repeatable)
  --prompt <text>       Send this plain prompt once the session is ready
  --wait                With --headless, exit when the sent prompt's turn has finished
  --verdict <path>      With --prompt/--wait, write the reply's verdict to this file
  --verdict-identity <id>  <runId>/<kind>/<step>/<attempt>/<seq> the verdict must declare
  --headless            Run --command without the terminal interface, then exit
  --deadline <minutes>  Stop the whole loop after this many minutes (DSHT_LOOP_DEADLINE)
  --auth-dir <path>     Private cookie directory (or DSHT_AUTH_DIR)
  --history-records <n> Soft history record limit (default 2000)
  --history-mb <n>      Soft history payload budget in MiB (default 16)
  --memory-log <path>   Append runtime memory samples; a failing log stops itself
  --no-memory-log       Disable the runtime memory log (default: enabled)
  --trace <path>        Append connection/screen/selection events (default: <state>/trace.log)
                        With the trace command, read that file instead of appending to it
  --no-trace            Disable the transition trace
  --trace-verbose       Quote sanitized child output in verifier failure reasons
  --no-shell            Disable ! local commands (DSHT_NO_SHELL=1)
  --json               Print machine-readable list or trace output
  --version            Print the package version and exit
  --help               Show this help

The default host is http://127.0.0.1:3080.
First login: export DSH_TOKEN, or export DSH_URL as the URL printed by dsh web.
Cookies are saved per server origin and reused on later starts. Tokens are never saved.
/cost shows the session, day, week and month CNY estimates.
/prompt lists saved shortcut prompts; /prompt TEXT saves one in <state>/prompts.json.
!command runs on this machine, not on the host, and prints its output in the transcript.
DSHT_CONFIG_DIR overrides the prices.json directory; DSHT_STATE_DIR overrides usage storage.
The shipped loop.yaml is read at startup; a loop.yaml in the config directory adds to it, and a
record with the same name replaces the shipped one. DSHT_LOOP_FILE names another file instead.
The memory log defaults to <state>/memory.log; DSHT_MEMORY_LOG sets another path or 'off'.
The transition trace defaults to <state>/trace.log; DSHT_TRACE sets another path or 'off'.
prices.json overrides the shipped rates and is seeded on first use; every scan re-decides the
history with the table loaded then, so an edited table reaches past requests on the next scan.
Examples:
  npx @itookit/dsht
  dsht list workspaces --json
  dsht list sessions --workspace <id> --json
  dsht trace --json
`;

/** State root this client reads and writes logs under, honouring the same overrides as the client. */
function stateRoot(): string {
  return process.env.DSHT_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dsht');
}

/** Read one trace file back as a few lines of facts.
 *
 * Needs no host and no credentials: the trace is the client's own record of what it did, and reading
 * it is the whole point of having written it.
 * @param requested - `--trace` value, when given.
 * @param json - Print the summary as JSON instead of lines.
 */
async function printTrace(requested: string | undefined, json: boolean): Promise<void> {
  const path = requested ?? process.env.DSHT_TRACE ?? join(stateRoot(), 'trace.log');
  const text = await readText(path);
  if (text === undefined) { process.stdout.write(`No trace at ${path}\n`); return; }
  const summary = summarizeTrace(text.split('\n').filter(line => line !== ''), path);
  process.stdout.write(json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatTraceSummary(summary).join('\n')}\n`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string', default: process.env.DSH_URL ?? 'http://127.0.0.1:3080' },
    'history-records': { type: 'string' }, 'history-mb': { type: 'string' },
    workspace: { type: 'string' }, ws: { type: 'string' }, session: { type: 'string' }, 'auth-dir': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
    command: { type: 'string', multiple: true }, prompt: { type: 'string' }, wait: { type: 'boolean' },
    verdict: { type: 'string' }, 'verdict-identity': { type: 'string' }, headless: { type: 'boolean' },
    deadline: { type: 'string' },
    'memory-log': { type: 'string' }, 'no-memory-log': { type: 'boolean' }, 'no-shell': { type: 'boolean' },
    trace: { type: 'string' }, 'no-trace': { type: 'boolean' }, 'trace-verbose': { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  // The version is read from the manifest rather than repeated here, so a release never has to edit
  // a string in this file; like `--help` it needs no host, no credentials and no terminal.
  if (values.version) { process.stdout.write(`${await packageVersion()}\n`); return; }
  const list = positionals[0] === 'list' && ['workspaces', 'sessions'].includes(positionals[1] ?? '') && positionals.length === 2;
  const trace = positionals[0] === 'trace' && positionals.length === 1;
  if (positionals.length && !list && !trace) throw new Error('Unknown command. Use --help.');
  if (!list && !trace && (values.json || values.workspace)) throw new Error('--json and --workspace apply to list or trace commands');
  if ((list || trace) && values.session) throw new Error('--session applies to interactive mode');
  if ((list || trace) && (values.ws || values.command?.length || values.prompt !== undefined || values.wait || values.headless || values.deadline)) {
    throw new Error('--ws, --command, --prompt, --wait, --deadline and --headless apply to interactive mode');
  }
  // Reading a trace needs no host, no credentials and no terminal, so it runs before any of them.
  if (trace) { await printTrace(values.trace, values.json === true); return; }
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
  // The loop records are configuration: the shipped file is read now, a user file layered over it and
  // the result installed before anything can list or run a record. An invalid user file stops the
  // client here rather than running shipped records while the operator believes their own are in
  // force; a shipped file that cannot be read falls back to the compiled-in records with a warning.
  const loopSource = await loadLoopSource({
    ...(process.env.DSHT_LOOP_FILE === undefined ? {} : { overlayFile: process.env.DSHT_LOOP_FILE }),
    configDirectory: config, stateDirectory: stateRoot,
  });
  installLoopSource(loopSource.source, loopSource.info);
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
    cwd: localDirectory, env: process.env,
    timeoutMs: verifyTimeoutMs(process.env.DSHT_VERIFY_TIMEOUT_MS),
    createSession: (title: string): Promise<string | undefined> => controller.actions.createVerifierSession(title),
    cancelSession: async (sessionId: string): Promise<void> => {
      if (!await controller.actions.cancelVerifierSession(sessionId)) throw new Error('Verifier cancellation was not accepted');
    },
    onLine: line => { if (values.headless) log(line); },
    // Off by default: a verifier reason reaches the progress line and the trace, and that log may be
    // pasted into a report, so the child's own words are quoted only when the operator asks.
    verbose: values['trace-verbose'] === true || process.env.DSHT_TRACE_VERBOSE === '1',
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
    deadlineMs: loopDeadlineMs(values.deadline ?? process.env.DSHT_LOOP_DEADLINE),
    memoryLogPath: memoryLogPath(stateRoot, values['memory-log'], values['no-memory-log']),
    tracePath: tracePath(stateRoot, values.trace, values['no-trace']),
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
  // Headless runs have no record list, so the loop source's notes would otherwise never be read.
  if (values.headless) for (const warning of loopSource.info.warnings) log(warning);
  controller.start();
  if (values.headless) {
    // No renderer: run the plan, follow a started loop to its verdict, and report it as the exit code.
    try {
      const outcome = await runStartup(controller, plan, log);
      // 0 passed, 1 failed, 3 waiting for a person: a script can tell the three apart.
      process.exitCode = outcome === 'failed' ? 1 : outcome === 'needs-human' ? 3 : 0;
    }
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

/** Read the published version from the manifest beside this entry point.
 *
 * The path is relative to this module, so it resolves both in the source tree (`src/cli/`) and in
 * the published build (`dist/cli/`). The version is never repeated as a literal, which is what lets
 * a release touch only `package.json` and the lockfile.
 * @returns The `version` field of `package.json`.
 */
async function packageVersion(): Promise<string> {
  const manifest = await readText(fileURLToPath(new URL('../../package.json', import.meta.url)));
  if (manifest === undefined) throw new Error('package.json is missing beside the client entry point');
  const version = string(object(JSON.parse(manifest)).version);
  if (version === '') throw new Error('package.json has no version');
  return version;
}

/** The identity a written verdict must declare, refused when the flag that carries it is missing.
 * @param value - `--verdict-identity` value.
 * @returns The identity.
 */
function requireIdentity(value: string | undefined): string {
  if (value === undefined || value.trim() === '') throw new Error('--verdict requires --verdict-identity');
  return value;
}

/** Whole-run budget from `--deadline`/`DSHT_LOOP_DEADLINE`, in minutes.
 *
 * Absent means no budget, which keeps the old behaviour for callers that never set one. A value that
 * is not a positive number is refused rather than silently ignored, because a run that was supposed
 * to be bounded and is not is worse than a startup error.
 * @param value - Flag or environment value.
 * @returns The budget in milliseconds, or undefined when unbounded.
 */
function loopDeadlineMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`--deadline must be a positive number of minutes: ${value}`);
  return Math.round(minutes * 60_000);
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
