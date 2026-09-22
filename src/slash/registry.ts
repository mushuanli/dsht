/** Slash-command catalog shared by completion, `/help` and the submission router. */
import type { Command } from './types.ts';

/** One slash command advertised by completion and `/help`. */
export interface CommandHint {
  /** Slash command as typed without arguments. */
  command: string;
  /** Argument hint shown after the command; absent when it takes none. */
  usage?: string;
  /** One-line action description shown by `/help`. */
  description: string;
  /** Must be typed in full: a unique prefix of it is completed, never executed on Enter. */
  exactOnly?: boolean;
}

/** Command discovery catalog shared by Tab completion and the `/help` panel. */
export const COMMAND_HINTS: readonly CommandHint[] = [
  { command: '/ws', usage: '[name or ID]', description: 'List/switch workspaces; --delete name removes registration' },
  { command: '/resume', usage: '[title or ID]', description: 'List/switch sessions; --delete ID archives with confirmation' },
  { command: '/model', usage: '[provider model [effort]]', description: 'Choose a model and reasoning effort for subsequent requests' },
  { command: '/new', description: 'Create a session in the selected workspace' },
  { command: '/copy', description: 'Freeze for native selection; Esc resumes (Ctrl+S shortcut)' },
  { command: '/latest', description: 'Return to the live conversation' },
  { command: '/older', description: 'Load earlier history' },
  { command: '/history', usage: '[text]', description: 'List your prompts, optionally filtered' },
  { command: '/prompt', usage: '[text]', description: 'Use a saved shortcut prompt, or save the text as one' },
  { command: '/search', usage: 'text', description: 'Search history page by page and open a match' },
  { command: '/ssearch', usage: 'text', description: 'Search sessions in the current workspace' },
  { command: '/wsearch', usage: 'text', description: 'Search sessions across all workspaces' },
  { command: '/compact', description: 'Compact older history while the session is idle' },
  { command: '/cancel', description: 'Cancel the active turn' },
  { command: '/queue', description: 'View and remove pending input' },
  { command: '/plan', usage: '[off|message]', description: 'Enter or leave host plan mode' },
  { command: '/goal', usage: '[action|objective]', description: 'View or manage the host task goal' },
  { command: '/permission', usage: '[preset]', description: 'View or switch the host permission preset' },
  { command: '/feedback', usage: 'text', description: 'Record feedback about the session' },
  { command: '/handoff', description: 'Delete local HANDOFF.md, then have the agent write a handoff' },
  { command: '/loop', usage: '[name|stop] [score] [tries]', description: 'Run a loop.yaml record; confirm defaults; stop/answer/abort', exactOnly: true },
  { command: '/export', usage: '[local.zip]', description: 'Save the session log ZIP to a new local file' },
  { command: '/export-html', usage: '[local.html]', description: 'Save loaded conversation with diagrams and math as offline HTML' },
  { command: '/coredump', usage: '[tag]', description: 'Write a V8 heap snapshot for memory diagnosis' },
  { command: '/allow', description: 'Approve the pending request once', exactOnly: true },
  { command: '/deny', description: 'Reject the pending request', exactOnly: true },
  { command: '/status', description: 'Show full session status details' },
  { command: '/cost', description: 'Show cost estimates and refresh usage' },
  { command: '/think', usage: '[seq or live]', description: 'Inspect reasoning with user prompt summaries' },
  { command: '/help', description: 'Show this command list' },
  { command: '/quit', description: 'Exit dsht', exactOnly: true },
];

/** Command names only, in catalog order. */
export const COMMANDS = COMMAND_HINTS.map(hint => hint.command);

/** Command column text per hint, aligned in the `/help` panel. */
export const COMMAND_LABELS = COMMAND_HINTS.map(hint => hint.usage === undefined ? hint.command : `${hint.command} ${hint.usage}`);

/** Widest command column, so descriptions start on one column. */
export const COMMAND_LABEL_WIDTH = Math.max(...COMMAND_LABELS.map(label => label.length)) + 2;

/** Commands that may only run when typed in full; a prefix of one is never executed on Enter. */
const EXACT_ONLY = new Set(COMMAND_HINTS.filter(hint => hint.exactOnly).map(hint => hint.command));

/** Commands whose name starts with one token, in catalog order.
 * @param token - First word of a draft, such as `/pro`.
 * @returns Matching command names, empty when the token names nothing.
 */
export function commandMatches(token: string): string[] {
  return COMMANDS.filter(command => command.startsWith(token));
}

/** Resolve one typed command token to the command it names.
 *
 * An exact command resolves to itself. A prefix that matches exactly one command resolves to that
 * command too, so Enter can run it without typing the whole name; an unknown or ambiguous token,
 * and any prefix of an `exactOnly` command, resolves to undefined so the draft stays as typed.
 * @param token - First word of a draft, without its arguments.
 * @returns The command name, or undefined when the token does not name one command.
 */
export function resolveCommand(token: string): string | undefined {
  if (COMMANDS.includes(token)) return token;
  const matches = commandMatches(token);
  const only = matches.length === 1 ? matches[0] : undefined;
  return only !== undefined && !EXACT_ONLY.has(only) ? only : undefined;
}

/** What may happen to a command while the selected conversation is busy.
 *
 * `'queue'` means the line is accepted and held until the fact clears; the front end fulfils it (it
 * owns the port and the view), and a scripted caller waits for the same fact before running the line.
 */
export type DuringExecution = 'run' | 'queue' | 'deny';

/** Where one parsed command may run, and what it must wait for.
 *
 * The names describe the application fact, not the screen that happens to represent it: a command
 * that needs a session is refused wherever no session is selected, and a front end cannot make that
 * requirement disappear by not having screens. An absent `duringTurn`/`duringLoop` means "no
 * constraint" — the many reads and local commands need no entry to keep running.
 */
export interface CommandPolicy {
  /** Needs a selected conversation. */
  requiresSession?: boolean;
  /** Refused while an approval or a question of that conversation is waiting. */
  requiresNoInteraction?: boolean;
  /** Belongs to the control lane of the session write gate: it preempts waiting writes (§6.3.2). */
  control?: boolean;
  /** While another operation owns the foreground slot, which is what the operator is watching. */
  whileBusy?: DuringExecution;
  /** While a turn of the selected conversation runs. */
  duringTurn?: DuringExecution;
  /** While a client-driven loop runs, which is what the operator must deal with first. */
  duringLoop?: DuringExecution;
}

/** Routing policy per parsed command kind.
 *
 * The pipeline reads this table instead of enumerating kinds itself, so a new command declares its
 * constraints next to its syntax and no other module learns about it. A kind absent here has no
 * constraint and may run from any screen, even while an answer is pending.
 */
/** A command that would write to the conversation another turn is already writing.
 *
 * `compact`, `handoff` and a `/loop` run each submit work of their own to the same session, so starting
 * one mid-turn would interleave two writers on one conversation. The list is deliberately short: the
 * host owns the busy rules of its own commands (`/plan`, `/goal`, `/model`, …), and a client-side deny
 * there would contradict what the host would have accepted.
 */
/** A command that writes to the conversation another turn is writing: it runs when that turn ends.
 *
 * These are the operator's own commands — a compaction, a handoff, a review to start — and refusing
 * them outright would make "I want this next" impossible to express while an agent works.
 */
const QUEUES_WHILE_RUNNING: CommandPolicy = { duringTurn: 'queue', duringLoop: 'queue' };

/** A command that must not run while another turn or loop owns the conversation at all. */
const CONFLICTS_WITH_RUNNING: CommandPolicy = { duringTurn: 'deny', duringLoop: 'deny' };

/** Commands that answer the operator or the host and must reach the session while it is busy.
 *
 * `whileBusy: 'run'` is the foreground-slot equivalent: cancelling an agent turn or settling the
 * interaction holding it is independent of whatever long operation the client is showing, and the
 * operator must never be told to wait for an export before they can stop the agent.
 */
const ANSWERS_WHILE_RUNNING: CommandPolicy = { duringTurn: 'run', duringLoop: 'run' };
const ANSWERS_WHILE_BUSY: CommandPolicy = { whileBusy: 'run' };

export const COMMAND_POLICY: Readonly<Partial<Record<Command['kind'], CommandPolicy>>> = {
  shell: { requiresSession: true },
  models: { requiresSession: true },
  queue: { requiresSession: true, requiresNoInteraction: true },
  history: { requiresSession: true },
  historySearch: { requiresSession: true },
  prompts: { requiresSession: true },
  // Reading reasoning while the agent works is the point of the panel.
  think: { requiresSession: true, ...ANSWERS_WHILE_RUNNING },
  panel: { ...ANSWERS_WHILE_RUNNING },
  copy: { ...ANSWERS_WHILE_RUNNING },
  // Cancelling the turn, or settling the interaction that is holding it, must never be refused.
  cancel: { ...ANSWERS_WHILE_RUNNING, ...ANSWERS_WHILE_BUSY },
  approval: { ...ANSWERS_WHILE_RUNNING, ...ANSWERS_WHILE_BUSY },
  compact: { requiresSession: true, ...QUEUES_WHILE_RUNNING },
  handoff: { requiresSession: true, requiresNoInteraction: true, ...QUEUES_WHILE_RUNNING },
  loop: { requiresSession: true, requiresNoInteraction: true, ...QUEUES_WHILE_RUNNING },
  // A record list is a surface for the draft being typed; by the time a turn ends, the operator has
  // moved on, so offering it later would be noise rather than help.
  loops: { requiresSession: true, requiresNoInteraction: true, ...CONFLICTS_WITH_RUNNING },
  // The host decides whether its own registered commands may run while a turn is in flight.
  hostCommand: { requiresSession: true, requiresNoInteraction: true },
  // Stopping is a control-lane action: it stays allowed while an approval waits, and while the very
  // line it is meant to interrupt still owns the controller, because that is exactly when it is needed.
  loopStop: { requiresSession: true, control: true, ...ANSWERS_WHILE_RUNNING, ...ANSWERS_WHILE_BUSY },
  // Answering a paused run and ending it must both work while the loop is what is running.
  loopAnswer: { requiresSession: true, ...ANSWERS_WHILE_RUNNING, ...ANSWERS_WHILE_BUSY },
  export: { requiresSession: true },
  exportHtml: { requiresSession: true },
};



/** Longest common prefix of the candidate commands, so Tab can extend an ambiguous draft.
 * @param values - Command candidates.
 * @returns The shared leading prefix.
 */
export function commonPrefix(values: string[]): string {
  let prefix = values[0] ?? '';
  for (const value of values) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index++;
    prefix = prefix.slice(0, index);
  }
  return prefix;
}

/** Complete the leading slash command; an ambiguous draft extends to the shared prefix.
 * @param input - Current composer draft.
 * @returns The completed draft, or undefined when nothing can be completed.
 */
export function completeCommand(input: string): string | undefined {
  if (!input.startsWith('/') || input.includes(' ')) return undefined;
  const matches = COMMANDS.filter(command => command.startsWith(input));
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only !== undefined) return `${only} `;
  const prefix = commonPrefix(matches);
  return prefix.length > input.length ? prefix : undefined;
}

/** Commands matching the current draft, shown under the composer.
 * @param input - Current composer draft.
 * @returns Candidate command names.
 */
export function suggestedCommands(input: string): string[] {
  return COMMANDS.filter(command => input.startsWith('/') && !input.includes(' ') && command.startsWith(input));
}

/** The catalog entry whose arguments the draft is currently typing.
 *
 * A usage line is only useful once the name is settled and arguments have begun, so this requires
 * whitespace after a token that names one command: `/model ` hints the model command, while `/co `
 * names none and `/think` is still completing a name. A unique prefix counts, because the same prefix
 * already runs that command.
 * @param input - Current composer draft.
 * @returns The command's hint, or undefined when no arguments are being typed.
 */
export function argumentHint(input: string): CommandHint | undefined {
  if (!input.startsWith('/')) return undefined;
  const space = input.search(/\s/);
  if (space <= 0) return undefined;
  const token = input.slice(0, space);
  const command = COMMANDS.includes(token) ? token : resolveCommand(token);
  return command === undefined ? undefined : COMMAND_HINTS.find(hint => hint.command === command);
}
