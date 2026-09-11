/** Slash-command catalog shared by completion, `/help` and the submission router. */

/** One slash command advertised by completion and `/help`. */
export interface CommandHint {
  /** Slash command as typed without arguments. */
  command: string;
  /** Argument hint shown after the command; absent when it takes none. */
  usage?: string;
  /** One-line action description shown by `/help`. */
  description: string;
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
  { command: '/export', usage: '[local.zip]', description: 'Save the session log ZIP to a new local file' },
  { command: '/export-html', usage: '[local.html]', description: 'Save loaded conversation with diagrams and math as offline HTML' },
  { command: '/allow', description: 'Approve the pending request once' },
  { command: '/deny', description: 'Reject the pending request' },
  { command: '/status', description: 'Show full session status details' },
  { command: '/cost', description: 'Show cost estimates and refresh usage' },
  { command: '/think', usage: '[seq or live]', description: 'Inspect reasoning with user prompt summaries' },
  { command: '/help', description: 'Show this command list' },
  { command: '/quit', description: 'Exit dsht' },
];

/** Command names only, in catalog order. */
export const COMMANDS = COMMAND_HINTS.map(hint => hint.command);

/** Command column text per hint, aligned in the `/help` panel. */
export const COMMAND_LABELS = COMMAND_HINTS.map(hint => hint.usage === undefined ? hint.command : `${hint.command} ${hint.usage}`);

/** Widest command column, so descriptions start on one column. */
export const COMMAND_LABEL_WIDTH = Math.max(...COMMAND_LABELS.map(label => label.length)) + 2;

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
