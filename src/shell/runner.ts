/** Running one local shell command for the reader, and nothing else.
 *
 * `!cmd` executes on the machine this client runs on — the operator's laptop or a jump host — never
 * on the host the agent works in. The host's shell belongs to the model's own tools; this module is
 * a separate, local facility, and it is the only place in `src/` allowed to spawn a process — including
 * the `dsht` child that verifies a scored round in a session of its own.
 */
import { spawn } from 'node:child_process';

/** Longest single output line kept while it is still being assembled. */
const MAX_LINE_CHARS = 8 * 1024;

/** How long a cancelled command may ignore SIGTERM before it is killed. */
const KILL_GRACE_MS = 2_000;

/** Which pipe one line arrived on. */
export type ShellStream = 'stdout' | 'stderr';

/** How one command ended. */
export interface ShellExit { code: number | null; signal: string | null }

/** One command's execution contract. */
export interface ShellRunOptions {
  /** Working directory; the client's own directory, not the host's. */
  cwd: string;
  /** Environment for the child; the caller strips client credentials first. */
  env: NodeJS.ProcessEnv;
  /** Cancels the run; the child's process group is terminated. */
  signal: AbortSignal;
  /** Receives every complete line, in arrival order across both pipes. */
  onLine(line: string, stream: ShellStream): void;
}

/** The interactive shell to run under, falling back to `sh` when `$SHELL` is unusable. */
function shellPath(): string {
  const chosen = process.env.SHELL;
  return chosen !== undefined && chosen !== '' ? chosen : '/bin/sh';
}

/** Terminate one child's whole process group, so pipelines and background children die with it.
 *
 * The child is spawned detached, which gives it its own group; signalling the group is what makes
 * cancellation behave like Ctrl+C in a terminal instead of leaving orphans holding the pipes.
 * @param child - The spawned shell.
 * @param signal - Signal to send the group.
 */
function signalGroup(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try { process.kill(-pid, signal); }
  catch { try { child.kill(signal); } catch { /* already gone */ } }
}

/** Run one command through the operator's shell and stream its lines.
 *
 * Both pipes are merged into one line stream in arrival order. A line longer than the assemble
 * budget is emitted once, truncated, and the remainder is discarded until the next newline, so a
 * command that never emits one cannot grow the client's memory.
 * @param command - Command line, exactly as typed after `!`.
 * @param options - Directory, environment, cancellation and the line sink.
 * @returns How the command ended.
 */
export function runShell(command: string, options: ShellRunOptions): Promise<ShellExit> {
  return spawnLines(shellPath(), ['-c', command], options);
}

/** Run one program with its own arguments, without a shell.
 *
 * A forked verifier is spawned this way: arguments reach the child verbatim, so a prompt can never be
 * re-read as shell syntax.
 * @param file - Program to run.
 * @param args - Arguments, passed verbatim.
 * @param options - Directory, environment, cancellation and the line sink.
 * @returns How the program ended.
 */
export function runProcess(file: string, args: readonly string[], options: ShellRunOptions): Promise<ShellExit> {
  return spawnLines(file, [...args], options);
}

/** Spawn one program, merge both pipes into a single line stream, and resolve when it closes.
 * @param file - Program to run.
 * @param args - Arguments, passed verbatim.
 * @param options - Directory, environment, cancellation and the line sink.
 * @returns How the program ended.
 */
function spawnLines(file: string, args: readonly string[], options: ShellRunOptions): Promise<ShellExit> {
  return new Promise<ShellExit>(resolve => {
    const child = spawn(file, [...args], {
      cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const carry: Record<ShellStream, string> = { stdout: '', stderr: '' };
    const discarding: Record<ShellStream, boolean> = { stdout: false, stderr: false };
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    /** Emit one assembled line, keeping the partial remainder for the next chunk. */
    const feed = (stream: ShellStream, chunk: string): void => {
      carry[stream] += chunk;
      for (;;) {
        const newline = carry[stream].indexOf('\n');
        if (newline < 0) break;
        const line = carry[stream].slice(0, newline);
        carry[stream] = carry[stream].slice(newline + 1);
        if (discarding[stream]) discarding[stream] = false;
        else options.onLine(line.replace(/\r$/, ''), stream);
      }
      if (carry[stream].length > MAX_LINE_CHARS) {
        if (!discarding[stream]) { options.onLine(`${carry[stream].slice(0, MAX_LINE_CHARS)}…`, stream); discarding[stream] = true; }
        carry[stream] = '';
      }
    };
    const flush = (stream: ShellStream): void => {
      if (carry[stream] !== '' && !discarding[stream]) options.onLine(carry[stream].replace(/\r$/, ''), stream);
      carry[stream] = '';
    };
    const finish = (exit: ShellExit): void => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      options.signal.removeEventListener('abort', onAbort);
      flush('stdout'); flush('stderr');
      resolve(exit);
    };
    const onAbort = (): void => {
      signalGroup(child, 'SIGTERM');
      graceTimer = setTimeout(() => { signalGroup(child, 'SIGKILL'); }, KILL_GRACE_MS);
    };

    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => feed('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => feed('stderr', chunk));
    child.on('error', error => { options.onLine(`! ${error.message}`, 'stderr'); finish({ code: null, signal: null }); });
    child.on('close', (code, signal) => finish({ code, signal }));
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  });
}
