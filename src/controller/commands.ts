/** Application-side command policy: what one submitted line does, and the view it leaves behind.
 *
 * The syntax lives in `slash/`, the effects and their notices live here, and `ui/app.tsx` only
 * interprets the returned `CommandIntent`. The UI therefore never learns which command ran, and a
 * new command needs no UI change unless it introduces a genuinely new presentational verb.
 */
import type { CommandIntent } from '../contracts.ts';
import type { Command } from '../slash/index.ts';
import type { Controller } from './controller.ts';

/** A routed line that still needs an effect: a parsed command, a free-text answer, or a host path. */
export type RunnableCommand =
  | Command
  | { kind: 'answer'; text: string }
  | { kind: 'path'; value: string };

/** What the command policy borrows from the UI while it runs. */
export interface CommandPort {
  /** Run one cancellable operation under the UI's loading label, abortable with Esc. */
  run<T>(label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined>;
}

/** Resolve a removal into either a finished removal or the confirmation the UI must show.
 *
 * Shared by the `/ws --delete`/`/resume --delete` commands and the pickers' `d` key, so the
 * empty-session rule has one implementation.
 * @param controller - Application facade the removal acts on.
 * @param kind - Workspace registration or session archival.
 * @param query - Exact name, ID, or unambiguous ID prefix.
 * @returns The intent, or undefined when the target could not be resolved.
 */
export async function removalIntent(controller: Controller, kind: 'workspace' | 'session', query: string): Promise<CommandIntent | undefined> {
  const target = await controller.actions.removalTarget(kind, query);
  if (target === undefined) return undefined;
  // An empty session carries no history, so it is archived without a review step.
  if (target.kind === 'session' && target.empty) {
    if (!await controller.actions.removeTarget(target)) return undefined;
    return { closePanels: true };
  }
  return { closePanels: true, open: 'removal', removal: target };
}

/** Run one submitted line and describe the view it leaves behind.
 *
 * Every branch is application policy: which action to call, which notice to show, and which panel
 * the result belongs to. The `ui` layer only turns the returned intent into component state.
 * @param controller - Application facade the command acts on.
 * @param command - Routed line; `ignore` and `reference` are UI modes and never reach here.
 * @param port - Cancellable-operation port supplied by the UI.
 * @returns The view intent, or undefined when the line was not accepted.
 */
export async function runCommand(controller: Controller, command: RunnableCommand, port: CommandPort): Promise<CommandIntent | undefined> {
  switch (command.kind) {
    case 'quit': return { quit: true };
    // Copy mode freezes the display, so panels are deliberately left as they are.
    case 'copy': return { copy: true };
    case 'panel':
      return { closePanels: true, toggle: command.panel };
    case 'remove':
      return await removalIntent(controller, command.target, command.query);
    case 'navigate': {
      const ok = command.target === 'workspace'
        ? await controller.actions.switchWorkspace(command.query)
        : await controller.actions.switchSession(command.query);
      return ok ? { closePanels: true, scroll: 0 } : undefined;
    }
    case 'path':
      return await controller.actions.createWorkspace(command.value) ? { closePanels: true } : undefined;
    case 'latest':
      controller.actions.setViewWindow(undefined);
      controller.actions.pinHistory(false);
      return { closePanels: true, live: true, pinLive: true, resetFolds: true, scroll: 0 };
    case 'models': {
      if (!command.args.length) {
        const catalog = await controller.actions.modelCatalog();
        return catalog === undefined ? undefined : { closePanels: true, model: { catalog } };
      }
      const ok = await controller.actions.selectModel(command.args[0]!, command.args[1]!, command.args[2]);
      return ok ? { closePanels: true, close: 'model' } : undefined;
    }
    case 'queue': return { closePanels: true, open: 'queue' };
    case 'prompts': return { closePanels: true, open: 'prompts' };
    case 'savePrompt':
      return await controller.actions.savePrompt(command.text) ? { closePanels: true, notice: 'Saved prompt' } : undefined;
    case 'shell':
      controller.shell.start(command.command);
      return { closePanels: true, scroll: 0 };
    case 'newSession':
      return await controller.actions.createSession() ? { closePanels: true } : undefined;
    case 'history':
      return { closePanels: true, history: { query: command.query, contentSearch: false } };
    case 'sessionSearch': {
      const result = await port.run('Searching sessions…', signal =>
        controller.actions.searchSessions(command.query, command.command === '/ssearch', signal));
      return result === undefined ? undefined
        : { closePanels: true, search: { query: command.query, ...result } };
    }
    case 'historySearch': {
      const matches = await port.run('Searching history…', signal =>
        controller.actions.searchHistory(command.query, signal));
      return matches === undefined ? undefined
        : { closePanels: true, history: { query: command.query, contentSearch: true, matches } };
    }
    case 'think': {
      if (command.target === 'live') return { closePanels: true, toggleLiveReasoning: true, scroll: 0 };
      if (!command.target) return { closePanels: true, open: 'thoughts' };
      const seq = Number(command.target);
      const transcript = controller.queries.window ?? controller.queries.record;
      if (!Number.isSafeInteger(seq) || !transcript.thoughts.some(entry => entry.seq === seq)) {
        throw new Error('Use /think <message sequence> for a loaded reasoning block');
      }
      return { closePanels: true, toggleFold: seq };
    }
    case 'older': {
      const ok = await controller.actions.older(undefined, controller.queries.window ?? controller.queries.record);
      return ok ? { closePanels: true, scrollBy: 10 } : undefined;
    }
    case 'compact': {
      const text = await port.run('Compacting history…', signal => controller.actions.command('/compact', signal));
      return text === undefined ? undefined : { closePanels: true, notice: text };
    }
    case 'cancel':
      return await controller.actions.cancelTurn() ? { closePanels: true } : undefined;
    case 'approval':
      return await controller.actions.approve(command.allowed) ? { closePanels: true } : undefined;
    case 'hostCommand': {
      const text = await port.run('Running command…', signal => controller.actions.command(command.line, signal));
      return text === undefined ? undefined : { closePanels: true, notice: text };
    }
    case 'export': {
      const saved = await port.run('Exporting session log…', signal =>
        controller.actions.exportLog(command.destination, signal));
      return saved === undefined ? undefined : { closePanels: true, notice: `Saved session log: ${saved}` };
    }
    case 'exportHtml': {
      const saved = await port.run('Exporting loaded conversation…', signal =>
        controller.actions.exportHtml(command.destination, signal));
      return saved === undefined ? undefined : { closePanels: true, notice: `Saved loaded conversation: ${saved}` };
    }
    case 'coredump': {
      // V8 serializes the heap synchronously, so the client stalls until the file is written.
      let saved = '';
      await port.run('Writing heap snapshot…', async () => { saved = controller.actions.heapSnapshot(command.tag); });
      return { closePanels: true, notice: `Heap snapshot saved: ${saved}` };
    }
    case 'answer': return { closePanels: true, answer: command.text };
    case 'error': return { closePanels: true, error: command.message };
    case 'prompt': {
      const ok = await controller.actions.prompt(command.text);
      controller.actions.setViewWindow(undefined);
      return ok ? { closePanels: true, live: true, scroll: 0 } : undefined;
    }
    case 'handoff': {
      if (!await controller.actions.handoff()) return undefined;
      controller.actions.setViewWindow(undefined);
      return { closePanels: true, live: true, scroll: 0, notice: 'Handoff requested · local HANDOFF.md cleared' };
    }
    default: return undefined;
  }
}
