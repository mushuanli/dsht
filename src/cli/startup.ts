/** Startup automation: pick a workspace and a session, then run the requested slash lines.
 *
 * This is the scriptable half of the client — `dsht --ws X --session new --command "…"` — so a
 * review can be launched without typing. It drives the same controller the UI drives, and applies
 * only the effect of each line: the presentational part of a command's intent belongs to the UI.
 */
import { runCommand, type CommandPort, type Controller } from '../controller/index.ts';
import { errorText } from '../transport/wire.ts';
import { dirname } from 'node:path';
import { ensureDirectory, renameFile, writePrivateFile } from '../storage/index.ts';
import { latestAssistantText } from '../controller/loop.ts';
import { parseVerdict } from '../controller/loop-contract.ts';
import { parseCommand } from '../slash/index.ts';

/** What the operator asked the client to do before/while taking over. */
export interface StartupPlan {
  /** Workspace ID, name or path; absent adopts the directory this client runs in. */
  workspace?: string;
  /** Session to open, or `new`; absent creates one when commands were given. */
  session?: string;
  /** Slash lines to run once the session is ready, in order. */
  commands: readonly string[];
  /** Plain prompt to send after the commands; a forked verifier drives a session this way. */
  prompt?: string;
  /** Wait for that prompt's turn to finish before returning, so the child exits on its own. */
  wait?: boolean;
  /** Where to persist the verdict this session produced, and the identity it must declare. */
  verdict?: VerdictTarget;
  /** Seconds a started loop may run before it is stopped. */
  timeoutSeconds: number;
}

/** The verdict file a forked verifier session must leave behind. */
export interface VerdictTarget {
  /** Absolute path to write. */
  file: string;
  /** `<runId>/<kind>/<step>/<attempt>`, checked against the reply before anything is written. */
  identity: string;
}

/** How the startup run ended. */
export type StartupOutcome = 'passed' | 'idle' | 'failed';

const POLL_MS = 250;
/** How long a connection, session or workspace operation may take. */
const STEP_TIMEOUT_MS = 30_000;
/** How long a forked child may wait for the session it was pointed at to stream its snapshot. */
const PROMPT_SNAPSHOT_TIMEOUT_MS = 180_000;
/** How long the verdict may take to appear after the turn was reported idle. */
const VERDICT_GRACE_MS = 5_000;
/** How often the reply is re-read while that grace lasts. */
const VERDICT_POLL_MS = 200;

/** Wait until one condition holds.
 * @param condition - Predicate polled until true.
 * @param what - Human-readable subject for the timeout message.
 * @param timeoutMs - Longest wait.
 */
async function until(condition: () => boolean, what: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

/** Run the plan against a started controller.
 * @param controller - Connected application facade.
 * @param plan - Workspace, session and lines to run.
 * @param log - Progress sink, usually stderr in headless mode.
 * @returns Whether a started loop passed, nothing ran, or the run failed.
 */
export async function runStartup(controller: Controller, plan: StartupPlan, log: (line: string) => void): Promise<StartupOutcome> {
  // `online` alone is too early: the startup picker runs after it and would overwrite a selection
  // made here, which is exactly how a forked verifier used to lose its session.
  await until(() => controller.state.online && controller.queries.connectionSettled, 'the host connection');
  if (plan.workspace !== undefined && !await controller.actions.switchWorkspace(plan.workspace)) {
    throw new Error(`Workspace not found: ${plan.workspace}`);
  }
  // An explicit `new`, or automation with no session named, starts a fresh conversation; the
  // workspace defaults to the directory this client runs in, registered on demand.
  if (plan.session === 'new' || plan.session === undefined && plan.commands.length > 0) {
    await ensureWorkspace(controller, log);
    if (!await controller.actions.createSession()) throw new Error('Could not create a session');
  } else if (plan.session !== undefined) {
    if (!await controller.actions.selectSession(plan.session)) throw new Error(`Session not found: ${plan.session}`);
  }

  // A selected session is not sendable until its follow snapshot lands.
  if (plan.commands.length) {
    await until(() => controller.state.screen === 'chat' && controller.state.sessionId !== undefined && controller.queries.record.ready, 'the session snapshot');
  }
  // Start-up lines are one-shot action commands; the cancellable port is only used by searches
  // and exports, which have no meaning before the operator is present.
  const port: CommandPort = { run: (_label, operation) => operation(controller.connection.signal()) };
  for (const line of plan.commands) {
    const command = parseCommand(line);
    if (command.kind === 'ignore') throw new Error('Empty command');
    if (command.kind === 'error') throw new Error(command.message);
    const intent = await runCommand(controller, command, port);
    if (intent === undefined) {
      const reason = controller.state.operation.error;
      throw new Error(`Command was not accepted: ${line}${reason ? ` (${reason})` : ''}`);
    }
    if (intent.error !== undefined) throw new Error(intent.error);
    if (intent.notice !== undefined) log(intent.notice);
  }

  // The count is taken before the prompt, because a turn can start and finish between two polls.
  const finishedBefore = controller.queries.turnsCompleted;
  if (plan.prompt !== undefined) {
    // Sending a prompt needs the follow snapshot, and a verifier starts the instant a busy turn ends,
    // so this wait is longer than a normal startup step: the host can be slow to open the new stream.
    try {
      await until(() => controller.state.sessionId !== undefined && controller.queries.record.ready,
        'the verifier session snapshot', PROMPT_SNAPSHOT_TIMEOUT_MS);
    } catch (error) {
      // Which of the three conditions failed is the whole diagnosis, so it travels with the error.
      throw new Error(`${errorText(error)} (screen=${controller.state.screen}, session=${controller.state.sessionId ?? 'none'},`
        + ` snapshot=${String(controller.queries.record.ready)}, online=${String(controller.state.online)})`);
    }
    await controller.actions.prompt(plan.prompt);
  }

  if (controller.queries.loop !== undefined) return await waitForLoop(controller, plan.timeoutSeconds * 1000, log);
  if (plan.wait) {
    const outcome = await waitForTurn(controller, finishedBefore, plan.timeoutSeconds * 1000, log);
    if (outcome === 'idle' && plan.verdict !== undefined) await writeVerdict(controller, plan.verdict, log);
    return outcome;
  }
  return 'idle';
}

/** Persist the verdict this session's reply just produced.
 *
 * The agent judges; this client owns the protocol file: the reply is parsed here and written through
 * a temporary file that is renamed into place, so a reader never sees a half-written verdict.
 * A reply with no usable verdict changes nothing — the parent validates whatever is there.
 * @param controller - Connected facade whose transcript holds the reply.
 * @param target - File to write and the identity the verdict must declare.
 * @param log - Progress sink.
 */
async function writeVerdict(controller: Controller, target: VerdictTarget, log: (line: string) => void): Promise<void> {
  const [, kind = '', step = '', attempt = ''] = target.identity.split('/');
  const expect = { verificationId: target.identity, kind, step: Number(step), attempt: Number(attempt) };
  // The host reports the turn idle just before that reply is committed, so an immediate parse can
  // find nothing; the verdict is only missing once it has had time to arrive.
  let parsed = parseVerdict(latestAssistantText(controller.queries.record.messages), expect);
  const deadline = Date.now() + VERDICT_GRACE_MS;
  while (parsed === undefined && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, VERDICT_POLL_MS));
    parsed = parseVerdict(latestAssistantText(controller.queries.record.messages), expect);
  }
  if (parsed === undefined) {
    // Say what the reply actually ended with: "no JSON at all" and "JSON that is not this round" are
    // different faults, and one line here is what tells them apart without another live run.
    const tail = latestAssistantText(controller.queries.record.messages).slice(-240).replace(/\s+/g, ' ');
    log(`No parsable verdict in the reply; leaving the verdict file untouched (reply tail: ${tail})`);
    return;
  }
  const body = JSON.stringify({
    verificationId: target.identity, kind, step: Number(step), attempt: Number(attempt),
    ...(parsed.score === undefined ? {} : { score: parsed.score }),
    ...(parsed.status === undefined ? {} : { status: parsed.status }),
    ...(parsed.blocked === true ? { blocked: true } : {}),
    ...(parsed.evidence === undefined ? {} : { evidence: parsed.evidence }),
    ...(parsed.findings === undefined ? {} : { top_findings: parsed.findings }),
  });
  await ensureDirectory(dirname(target.file));
  const temporary = `${target.file}.part`;
  await writePrivateFile(temporary, body);
  await renameFile(temporary, target.file);
  log(`Verdict written to ${target.file}`);
}

/** Follow a sent prompt's turn to its end, which is what lets a forked child exit by itself.
 *
 * The host's idle event is the same signal the scored loop trusts: it cannot be missed by polling,
 * and a turn that starts and ends between two polls still counts.
 * @param controller - Connected application facade.
 * @param finishedBefore - Turns completed before the prompt was sent.
 * @param timeoutMs - Longest wait.
 * @param log - Progress sink.
 * @returns `idle` when the turn ended, `failed` on timeout.
 */
async function waitForTurn(controller: Controller, finishedBefore: number, timeoutMs: number, log: (line: string) => void): Promise<StartupOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (controller.queries.turnsCompleted > finishedBefore) { log('Turn finished'); return 'idle'; }
    if (Date.now() >= deadline) { log('Turn timed out'); return 'failed'; }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

/** Select the directory this client runs in, registering it when the host does not know it yet. */
async function ensureWorkspace(controller: Controller, log: (line: string) => void): Promise<void> {
  if (controller.state.workspaceId !== undefined) return;
  if (await controller.actions.switchWorkspace(controller.localDirectory)) return;
  log(`Registering ${controller.localDirectory} as a workspace`);
  if (!await controller.actions.createWorkspace(controller.localDirectory)) {
    throw new Error(`Could not use ${controller.localDirectory} as a workspace`);
  }
}

/** Follow a running loop to its terminal phase, reporting progress changes.
 * @returns `passed` when the loop met its threshold, `failed` otherwise.
 */
async function waitForLoop(controller: Controller, timeoutMs: number, log: (line: string) => void): Promise<StartupOutcome> {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  for (;;) {
    const progress = controller.queries.loop;
    if (progress === undefined || progress.phase !== 'running') {
      // A cancelled loop usually means the connection ended; say so, or the exit code is a mystery.
      const why = controller.state.operation.error || controller.state.status;
      log(`Loop ${progress?.phase ?? 'gone'}${why ? ` · ${why}` : ''}${progress?.note === undefined ? '' : ` · ${progress.note}`}`);
      return progress?.phase === 'passed' ? 'passed' : 'failed';
    }
    const label = progress.stepLabel === undefined ? '' : ` · ${progress.stepLabel}`;
    // The note carries why an attempt was decided the way it was — including why verification was
    // unavailable — so a headless run is diagnosable without a renderer.
    const note = progress.note === undefined ? '' : ` · ${progress.note}`;
    const line = `${progress.title}${label} · step ${progress.step}/${progress.to} · attempt ${progress.attempt}/${progress.tries} · best ${progress.best}/${progress.score}${note}`;
    if (line !== previous) { previous = line; log(line); }
    if (Date.now() >= deadline) {
      controller.actions.stopLoop();
      log('Loop timed out and was stopped');
      return 'failed';
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
