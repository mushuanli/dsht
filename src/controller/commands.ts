/** Application-side command policy: what one submitted line does, and the view it leaves behind.
 *
 * The syntax lives in `slash/`, the effects and their notices live here, and `ui/app.tsx` only applies
 * the returned `ViewEffect[]`. The UI therefore never learns which command ran, and a new command
 * needs no UI change unless it introduces a genuinely new presentational verb.
 */
import type { CommandResult, ViewEffect } from '../contracts.ts';
import { LOOP_USAGE, type LineCommand } from '../slash/index.ts';
import { errorText } from '../transport/wire.ts';
import type { Controller } from './controller.ts';
import { loopProtocolFor, loopProtocolNames, loopRecordVars } from './loop-protocols.ts';
import { resolveLoop } from './loop.ts';

/** A line the application can execute: a parsed command, a free-text answer, or a host path.
 *
 * The shape is slash's (`LineCommand`), because "what a line means" is settled before the application
 * is involved; this layer owns only the effect.
 */
export type RunnableCommand = LineCommand;

/** What the command policy borrows from the UI while it runs. */
export interface CommandPort {
  /** Run one cancellable operation under the UI's loading label, abortable with Esc. */
  run<T>(label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined>;
  /** Whether the caller can show a surface and wait for the operator.
   *
   * A command that would otherwise need a decision may borrow a panel only here; a scripted or
   * headless caller leaves this unset and gets the command's direct effect instead of a form nobody
   * could answer. Optional on purpose: the safe default is "nobody is watching".
   */
  readonly interactive?: boolean;
}

/** An accepted line: apply these effects in order, then clear the draft. */
function ok(effects: ViewEffect[]): CommandResult {
  return { disposition: 'consume', outcome: 'ok', effects };
}

/** A refusal the operator can read; the draft — and any form on screen — stays where it is.
 *
 * A line that never ran does not rearrange the screen: closing panels is a view transition belonging
 * to a command that executed, and doing it here would throw away a form the reader is still editing
 * (the `/loop` parameter form is the case that found this).
 * @param text - Failure line, applied last so the other effects cannot replace it.
 * @param effects - What else to do first, when a caller really does want a surface closed.
 */
function refused(text: string, effects: ViewEffect[] = []): CommandResult {
  return { disposition: 'retain', outcome: 'rejected', effects: [...effects, { kind: 'error', text }] };
}

/** An operation the caller aborted (Esc): nothing to show, and nothing to clear. */
function cancelled(): CommandResult {
  return { disposition: 'retain', outcome: 'cancelled', effects: [] };
}

/** One cancellable port call, reporting whether the caller aborted it.
 *
 * `undefined` from the port means "no value" for two different reasons, and the result type must not
 * confuse them: a refusal to start is not an interruption the operator caused.
 */
async function runCancellable<T>(port: CommandPort, label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<{ value: T | undefined; cancelled: boolean }> {
  let signal: AbortSignal | undefined;
  const value = await port.run(label, inner => { signal = inner; return operation(inner); });
  return { value, cancelled: value === undefined && signal?.aborted === true };
}

/** Resolve a removal into either a finished removal or the confirmation the UI must show.
 *
 * Shared by the `/ws --delete`/`/resume --delete` commands and the pickers' `d` key, so the
 * empty-session rule has one implementation.
 * @param controller - Application facade the removal acts on.
 * @param kind - Workspace registration or session archival.
 * @param query - Exact name, ID, or unambiguous ID prefix.
 * @returns The effects to apply, or undefined when the target could not be resolved.
 */
export async function removalIntent(controller: Controller, kind: 'workspace' | 'session', query: string): Promise<ViewEffect[] | undefined> {
  const target = await controller.actions.removalTarget(kind, query);
  if (target === undefined) return undefined;
  // An empty session carries no history, so it is archived without a review step.
  if (target.kind === 'session' && target.empty) {
    if (!await controller.actions.removeTarget(target)) return undefined;
    return [{ kind: 'closePanels' }];
  }
  return [{ kind: 'closePanels' }, { kind: 'open', panel: 'removal' }, { kind: 'removal', removal: target }];
}

/** Run one submitted line and describe what it did and what the front end must show.
 *
 * This is the single entry point every front end uses — the composer and the scripted startup runner
 * alike — so one line has one effect and one trace span wherever it came from.
 * @param controller - Application facade the command acts on.
 * @param command - Executable line; the front-end modes (`ignore`, `reference`) never reach here.
 * @param port - Cancellable-operation port supplied by the caller.
 * @returns The result, or undefined when the application did not accept the line.
 */
export async function runCommand(controller: Controller, command: RunnableCommand, port: CommandPort): Promise<CommandResult | undefined> {
  // A finished run's progress line is a result the reader may still be reading; running this line means
  // they are done with it. A run that is still active is never dropped here, so `/loop answer` and
  // `/loop stop` keep their target — and this runs before the line's own effects, so the line that
  // ends a run still leaves its terminal progress on screen to be read.
  controller.actions.clearLoopResult();
  // One span per executed line, with the id every other event of this line can name. The begin is
  // written before any effect, so a crash mid-command still shows that the executor was entered.
  const commandId = controller.nextCommandId();
  controller.traceNote('command', { phase: 'begin', commandId, kind: command.kind });
  // What the action envelope said before this line ran: a failure it records during the line is this
  // line's own, and the result below is where the operator reads it.
  const envelopeBefore = controller.state.lastFailure;
  let result: CommandResult | undefined;
  try {
    result = await execute(controller, command, port);
  } catch (error) {
    // The end must be written whatever happened, or one begin would never have its end.
    controller.traceNote('command', { phase: 'end', commandId, kind: command.kind, outcome: 'failed',
      disposition: 'retain', error: errorText(error).slice(0, 200) });
    throw error;
  }
  // The end is the one place that answers "how did this line end", whatever the command, so no command
  // has to invent its own outcome name — and the outcome here is the same fact the reader is shown.
  const failure = result?.effects.find(effect => effect.kind === 'error');
  controller.traceNote('command', { phase: 'end', commandId, kind: command.kind,
    outcome: result?.outcome ?? 'refused', disposition: result?.disposition ?? 'retain',
    ...(failure?.kind === 'error' ? { error: failure.text.slice(0, 200) } : {}) });
  // One fact, one channel (13.2-D2): a failure this line already reported in its result must not stay
  // in the action envelope and be shown a second time in the status bar. An unaccepted line keeps it —
  // there the envelope is the only explanation the operator has.
  if (result !== undefined && result.outcome !== 'ok' && controller.state.lastFailure !== envelopeBefore) {
    controller.actions.clearFailure();
  }
  return result;
}

/** Dispatch one executable line to its application policy.
 *
 * Every branch is application policy: which action to call, which notice to show, and which panel the
 * result belongs to. The `ui` layer only applies the returned effects to component state.
 * @param controller - Application facade the command acts on.
 * @param command - Executable line.
 * @param port - Cancellable-operation port supplied by the caller.
 * @returns The result, or undefined when the application did not accept the line.
 */
async function execute(controller: Controller, command: RunnableCommand, port: CommandPort): Promise<CommandResult | undefined> {
  switch (command.kind) {
    case 'quit': return ok([{ kind: 'quit' }]);
    // Copy mode freezes the display, so panels are deliberately left as they are.
    case 'copy': return ok([{ kind: 'copy' }]);
    case 'panel': {
      // The cost panel is the one panel whose rows are a host request. Opening it starts that request
      // here, where the effect lives, rather than in the front end: the UI only shows its loading label.
      if (command.panel === 'cost') {
        void port.run('Refreshing costs…', signal => controller.actions.refreshCosts(signal)).catch(() => undefined);
      }
      return ok([{ kind: 'closePanels' }, { kind: 'toggle', panel: command.panel }]);
    }
    case 'remove': {
      const effects = await removalIntent(controller, command.target, command.query);
      return effects === undefined ? undefined : ok(effects);
    }
    case 'navigate': {
      const accepted = command.target === 'workspace'
        ? await controller.actions.switchWorkspace(command.query)
        : await controller.actions.switchSession(command.query);
      return accepted ? ok([{ kind: 'closePanels' }, { kind: 'scroll', position: 0 }]) : undefined;
    }
    case 'path':
      return await controller.actions.createWorkspace(command.value) ? ok([{ kind: 'closePanels' }]) : undefined;
    case 'latest':
      return ok([{ kind: 'closePanels' }, { kind: 'live' }, { kind: 'pinLive' }, { kind: 'resetFolds' }, { kind: 'scroll', position: 0 }]);
    case 'models': {
      if (!command.args.length) {
        const catalog = await controller.actions.modelCatalog();
        return catalog === undefined ? undefined : ok([{ kind: 'closePanels' }, { kind: 'model', model: { catalog } }]);
      }
      const accepted = await controller.actions.selectModel(command.args[0]!, command.args[1]!, command.args[2]);
      return accepted ? ok([{ kind: 'closePanels' }, { kind: 'close', panel: 'model' }]) : undefined;
    }
    case 'queue': return ok([{ kind: 'closePanels' }, { kind: 'open', panel: 'queue' }]);
    case 'prompts': return ok([{ kind: 'closePanels' }, { kind: 'open', panel: 'prompts' }]);
    case 'savePrompt':
      return await controller.actions.savePrompt(command.text)
        ? ok([{ kind: 'closePanels' }, { kind: 'notice', text: 'Saved prompt' }]) : undefined;
    case 'shell':
      controller.shell.start(command.command);
      return ok([{ kind: 'closePanels' }, { kind: 'scroll', position: 0 }]);
    case 'newSession':
      return await controller.actions.createSession() ? ok([{ kind: 'closePanels' }]) : undefined;
    case 'history':
      return ok([{ kind: 'closePanels' }, { kind: 'history', history: { query: command.query, contentSearch: false } }]);
    case 'sessionSearch': {
      const { value: result, cancelled: aborted } = await runCancellable(port, 'Searching sessions…', signal =>
        controller.actions.searchSessions(command.query, command.command === '/ssearch', signal));
      if (result === undefined) return aborted ? cancelled() : undefined;
      return ok([{ kind: 'closePanels' }, { kind: 'search', search: { query: command.query, ...result } }]);
    }
    case 'historySearch': {
      const { value: matches, cancelled: aborted } = await runCancellable(port, 'Searching history…', signal =>
        controller.actions.searchHistory(command.query, signal));
      if (matches === undefined) return aborted ? cancelled() : undefined;
      return ok([{ kind: 'closePanels' }, { kind: 'history', history: { query: command.query, contentSearch: true, matches } }]);
    }
    case 'think': {
      if (command.target === 'live') {
        return ok([{ kind: 'closePanels' }, { kind: 'toggleLiveReasoning' }, { kind: 'scroll', position: 0 }]);
      }
      if (!command.target) return ok([{ kind: 'closePanels' }, { kind: 'open', panel: 'thoughts' }]);
      const seq = Number(command.target);
      const transcript = controller.queries.window ?? controller.queries.record;
      if (!Number.isSafeInteger(seq) || !transcript.thoughts.some(entry => entry.seq === seq)) {
        throw new Error('Use /think <message sequence> for a loaded reasoning block');
      }
      return ok([{ kind: 'closePanels' }, { kind: 'toggleFold', seq }]);
    }
    case 'older': {
      const accepted = await controller.actions.older(undefined, controller.queries.window ?? controller.queries.record);
      return accepted ? ok([{ kind: 'closePanels' }, { kind: 'scrollBy', delta: 10 }]) : undefined;
    }
    case 'compact': {
      const { value: text, cancelled: aborted } = await runCancellable(port, 'Compacting history…', signal =>
        controller.actions.command('/compact', signal));
      if (text === undefined) return aborted ? cancelled() : undefined;
      return ok([{ kind: 'closePanels' }, { kind: 'notice', text }]);
    }
    case 'cancel':
      return await controller.actions.cancelTurn() ? ok([{ kind: 'closePanels' }]) : undefined;
    case 'approval':
      return await controller.actions.approve(command.allowed) ? ok([{ kind: 'closePanels' }]) : undefined;
    case 'hostCommand': {
      const { value: text, cancelled: aborted } = await runCancellable(port, 'Running command…', signal =>
        controller.actions.command(command.line, signal));
      if (text === undefined) return aborted ? cancelled() : undefined;
      return ok([{ kind: 'closePanels' }, { kind: 'notice', text }]);
    }
    case 'export': {
      const { value: saved, cancelled: aborted } = await runCancellable(port, 'Exporting session log…', signal =>
        controller.actions.exportLog(command.destination, signal));
      if (saved === undefined) return aborted ? cancelled() : undefined;
      return ok([{ kind: 'closePanels' }, { kind: 'notice', text: `Saved session log: ${saved}` }]);
    }
    case 'exportHtml': {
      const { value: saved, cancelled: aborted } = await runCancellable(port, 'Exporting loaded conversation…', signal =>
        controller.actions.exportHtml(command.destination, signal));
      if (saved === undefined) return aborted ? cancelled() : undefined;
      return ok([{ kind: 'closePanels' }, { kind: 'notice', text: `Saved loaded conversation: ${saved}` }]);
    }
    case 'coredump': {
      // V8 serializes the heap synchronously, so the client stalls until the file is written.
      let saved = '';
      await port.run('Writing heap snapshot…', async () => { saved = controller.actions.heapSnapshot(command.tag); });
      return ok([{ kind: 'closePanels' }, { kind: 'notice', text: `Heap snapshot saved: ${saved}` }]);
    }
    case 'answer': {
      // The application completes the question waterfall itself, so a line that answers one never
      // leaves the front end to call `answer` on its own.
      const accepted = await controller.actions.answerQuestion({ custom: command.text });
      return accepted ? ok([{ kind: 'closePanels' }]) : undefined;
    }
    case 'error': return refused(command.message);
    case 'prompt': {
      const accepted = await controller.actions.prompt(command.text);
      return accepted ? ok([{ kind: 'closePanels' }, { kind: 'live' }, { kind: 'scroll', position: 0 }]) : undefined;
    }
    case 'handoff': {
      if (!await controller.actions.handoff()) return undefined;
      return ok([{ kind: 'closePanels' }, { kind: 'live' }, { kind: 'scroll', position: 0 },
        { kind: 'notice', text: 'Handoff requested · local HANDOFF.md cleared' }]);
    }
    case 'loops':
      // The record list is a composer surface the UI offers while the name is typed; a line that
      // still reaches here has nobody to choose for it, so it is told to name one.
      return refused(`Use /loop <name> · available: ${loopProtocolNames().join(', ')}`);
    case 'loopAnswer': {
      const progress = controller.queries.loop;
      const interaction = progress?.interaction;
      // The answer only means something to a judgment that asked for one; a host question is answered
      // in its own dialog, and a rejected send retries on its own. Saying which is which beats a
      // command that appears to do nothing.
      if (progress === undefined || !progress.active || progress.phase !== 'needs-human' || interaction?.kind !== 'verdict') {
        return refused(interaction === undefined
          ? 'No loop is waiting for an answer'
          : `This run is waiting for a ${interaction.kind}: ${interaction.text} · answer it, or /loop abort`);
      }
      const accepted = await controller.actions.answerLoop(command.text);
      return accepted
        ? ok([{ kind: 'closePanels' }, { kind: 'live' }, { kind: 'scroll', position: 0 },
          { kind: 'notice', text: `Answer added · re-judging step ${progress.step}` }])
        : undefined;
    }
    case 'loopStop': {
      // Stopping is a control command, so it is answered from the application's own view of the run
      // rather than refused when nothing runs; a no-op that says so beats silence.
      const progress = controller.queries.loop;
      if (progress === undefined || !progress.active) return ok([{ kind: 'closePanels' }, { kind: 'notice', text: 'No loop is running' }]);
      controller.actions.stopLoop();
      return ok([{ kind: 'closePanels' }, { kind: 'live' }, { kind: 'scroll', position: 0 },
        { kind: 'notice', text: `Loop stopped · ${progress.title}` }]);
    }
    case 'loop': {
      // One command for every record: the name is looked up here, where the records are known, so
      // the syntax layer never needs a table of protocols and a new record needs no code at all.
      controller.traceNote('loop', { phase: 'command', name: command.name, interactive: port.interactive === true,
        flags: Object.keys(command.options).filter(key => key !== 'vars'), vars: Object.keys(command.options.vars ?? {}) });
      const declared = loopRecordVars(command.name);
      if (declared === undefined) {
        controller.traceNote('loop', { phase: 'rejected', name: command.name, reason: 'unknown-record' });
        return refused(`Unknown loop record: ${command.name} · available: ${loopProtocolNames().join(', ')}`);
      }
      // A record variable only exists if the record declares it; retargeting is not a place to guess.
      const vars = command.options.vars ?? {};
      const unknown = Object.keys(vars).filter(name => !(name in declared));
      if (unknown.length) {
        const names = Object.keys(declared);
        controller.traceNote('loop', { phase: 'rejected', name: command.name, reason: 'unknown-vars', vars: unknown });
        return refused(`Unknown loop variable: ${unknown.join(', ')}`
          + ` · ${command.name} accepts: ${names.length ? names.join(', ') : 'none'}`);
      }
      // Any value the operator already chose — a flag, or a variable the form confirmed — means the
      // decision is made; only a bare known record leaves every default open for the form.
      const decided = command.options.from !== undefined || command.options.to !== undefined
        || command.options.score !== undefined || command.options.tries !== undefined
        || Object.keys(vars).length > 0;
      if (port.interactive === true && !decided) {
        controller.traceNote('loop', { phase: 'form', name: command.name });
        return ok([{ kind: 'closePanels' }, { kind: 'loop', loop: { name: command.name } }]);
      }
      const protocol = loopProtocolFor(command.name, controller.queries.forkedVerification, vars);
      if (protocol === undefined) return refused(LOOP_USAGE);
      const limits = resolveLoop(protocol, command.options);
      if (limits === undefined) return refused(LOOP_USAGE);
      if (!await controller.actions.startLoop(protocol, limits)) {
        // `startLoop` already traced its own refusal; this turns the same fact into something the
        // operator can read, instead of a form that appears to ignore Start. The form stays on screen
        // so the values can be retried.
        const why = controller.state.lastFailure
          || (controller.state.online ? 'the host did not accept the request' : 'the client is offline');
        controller.traceNote('loop', { phase: 'not-started', name: command.name, why: why.slice(0, 200) });
        return refused(`Loop did not start: ${why}`);
      }
      // The run leaves a bar in the transcript where it started, so the loop is readable in place and
      // the bar can open the verification session this run is using (`Controller.createVerifierSession`).
      // A record that starts by verifying (`starts: verify`) already created that session inside
      // `startLoop`, so the bar takes the newest one now and later checks re-point it through `link`.
      const checking = controller.queries.sources.find(source => source.createdBy === 'verifier' && source.state === 'running');
      controller.shell.note(`/loop ${command.name} ${limits.from}–${limits.to} · pass ${limits.score} · ≤${limits.tries} tries`,
        checking?.id);
      return ok([{ kind: 'closePanels' }, { kind: 'live' }, { kind: 'scroll', position: 0 },
        { kind: 'notice', text: `${protocol.title} started · steps ${limits.from}–${limits.to} · pass ${limits.score} · ≤${limits.tries} tries` }]);
    }
    default: return undefined;
  }
}
