/** Slash-command domain: the command catalog, its syntax and the completion helpers.
 *
 * A pure leaf: it imports nothing from the application, the features or the UI.
 */
export { COMMAND_HINTS, COMMAND_LABELS, COMMAND_LABEL_WIDTH, COMMANDS, COMMAND_POLICY, argumentHint, commandMatches, commonPrefix, completeCommand, resolveCommand, suggestedCommands } from './registry.ts';
export type { CommandHint, CommandPolicy } from './registry.ts';
export { parseCommand, loopNameQuery, validLoopOption, LOOP_ABORT_USAGE, LOOP_ANSWER_USAGE, LOOP_STOP_USAGE, LOOP_USAGE } from './parse.ts';
export type { Command, LoopOptions } from './parse.ts';
export { interpret, normalize, authorize } from './pipeline.ts';
export type { AuthorizeFacts, DeferReason, ExecutableSubmission, InterpretFacts, LineCommand, NormalizeFacts, Submission, UiAction, Verdict } from './pipeline.ts';
