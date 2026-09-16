/** Controller domain: the application facade and the connection it owns. */
export { Controller } from './controller.ts';
export type { ControllerOptions, HistorySearch, RemovalTarget, SavedPrompt, State } from './controller.ts';
export { removalIntent, runCommand } from './commands.ts';
export type { CommandPort, RunnableCommand } from './commands.ts';
export { designReviewProtocol, DESIGN_REVIEW_ROUNDS } from './design-review.ts';
export { LOOP_MARKER, LOOP_STATUSES, followUpContract, resultContract } from './loop-contract.ts';
export { promptLoopProtocol } from './loop-prompt.ts';
export { ScoredLoop, parseLoopResult, resolveLoop } from './loop.ts';
export type { LoopLimits, LoopProtocol, LoopResult, LoopStepResult } from './loop.ts';
export { PromptStore, MAX_PROMPT_CHARS, MAX_SAVED_PROMPTS } from './prompts.ts';
export { ConnectionController } from './connection.ts';
export type { ConnectionListener, ConnectionOptions } from './connection.ts';
