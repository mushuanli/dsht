/** Slash-command domain: the command catalog, its syntax and the completion helpers.
 *
 * A pure leaf: it imports nothing from the application, the features or the UI.
 */
export { COMMAND_HINTS, COMMAND_LABELS, COMMAND_LABEL_WIDTH, COMMANDS, commonPrefix, completeCommand, suggestedCommands } from './registry.ts';
export { parseCommand } from './parse.ts';
export type { Command } from './parse.ts';
