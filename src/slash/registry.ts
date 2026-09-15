/** Slash-command catalog shared by completion, `/help` and the submission router. */
import type { Command } from './parse.ts';

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

/** Where one parsed command may run, and what it must wait for. */
export interface CommandPolicy {
  /** Needs a selected conversation, so a picker screen refuses it. */
  chatOnly?: boolean;
  /** Refused while an approval or a question is waiting. */
  blockedByPending?: boolean;
}

/** Routing policy per parsed command kind.
 *
 * The router reads this table instead of enumerating kinds itself, so a new command declares its
 * constraints next to its syntax and no other module learns about it. A kind absent here has no
 * constraint and may run from any screen, even while an answer is pending.
 */
export const COMMAND_POLICY: Readonly<Partial<Record<Command['kind'], CommandPolicy>>> = {
  shell: { chatOnly: true },
  models: { chatOnly: true },
  queue: { chatOnly: true, blockedByPending: true },
  history: { chatOnly: true },
  prompts: { chatOnly: true },
  think: { chatOnly: true },
  compact: { chatOnly: true },
  handoff: { chatOnly: true, blockedByPending: true },
  hostCommand: { chatOnly: true, blockedByPending: true },
  export: { chatOnly: true },
  exportHtml: { chatOnly: true },
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
