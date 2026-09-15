/** Slash-command domain: the command catalog, its syntax and the completion helpers.
 *
 * A pure leaf: it imports nothing from the application, the features or the UI.
 */
export { COMMAND_HINTS, COMMAND_LABELS, COMMAND_LABEL_WIDTH, COMMANDS, COMMAND_POLICY, commandMatches, commonPrefix, completeCommand, resolveCommand, suggestedCommands } from './registry.ts';
export type { CommandHint, CommandPolicy } from './registry.ts';
export { parseCommand, parseLoopOptions, DESIGN_REVIEW_USAGE, LOOP_USAGE } from './parse.ts';
export type { Command, LoopOptions } from './parse.ts';
