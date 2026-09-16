/** Shell domain: the local `!` command runner and the bounded blocks it produces. */
export { ShellController } from './controller.ts';
export type { ShellBlock, ShellHost, ShellSnapshot } from './controller.ts';
export { runProcess, runShell } from './runner.ts';
export type { ShellExit, ShellRunOptions, ShellStream } from './runner.ts';
