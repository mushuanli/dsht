/** Controller domain: the application facade and the connection it owns. */
export { Controller } from './controller.ts';
export type { ControllerOptions, HistorySearch, RemovalTarget, SavedPrompt, State } from './controller.ts';
export { removalIntent, runCommand } from './commands.ts';
export type { CommandPort, RunnableCommand } from './commands.ts';
export { PromptStore, MAX_PROMPT_CHARS, MAX_SAVED_PROMPTS } from './prompts.ts';
export { ConnectionController } from './connection.ts';
export type { ConnectionListener, ConnectionOptions } from './connection.ts';
