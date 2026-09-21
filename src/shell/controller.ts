/** Local shell runs the reader started with `!`, kept as bounded blocks for inline display.
 *
 * A block is the command line plus its retained output. Output is capped by both lines and bytes, so
 * a runaway command can only fill its block, and only the newest blocks are kept. Nothing here is
 * durable: no host record, no session state, no file.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { runShell, type ShellStream } from './runner.ts';

/** Output lines one block keeps before it drops the oldest. */
const BLOCK_LINES = 200;
/** Output bytes one block keeps before it drops the oldest. */
const BLOCK_BYTES = 64 * 1024;
/** Runs kept for display; the newest always survives. */
const BLOCK_LIMIT = 20;
/** Fastest repaint cadence while output streams; status changes always publish. */
const PUBLISH_INTERVAL_MS = 80;

/** Readable id of one `!` run's own output, so its transcript bar and its source entry agree. */
export function localSourceId(id: number): string { return `shell:${id}`; }

/** One local command and the output retained for it.
 *
 * A block is either a `!` process (`shell`) or a client command echoed so its bar can be read and
 * clicked (`note`). A note runs nothing; it carries the readable source its bar opens, which the
 * application links once the thing it announced exists.
 */
export interface ShellBlock {
  id: number;
  /** What produced the block: a local process, or a command echoed for reading. */
  kind: 'shell' | 'note';
  /** Readable source this block's bar opens: its own lines, or the session a note announces. */
  source?: string;
  command: string;
  /** Retained output lines, oldest first. */
  lines: string[];
  /** Lines dropped from the front because the block exceeded its budget. */
  dropped: number;
  /** Durable sequence that was newest when the command started; the block is shown after it. */
  anchor: number;
  status: 'running' | 'exited';
  /** Exit code, once the command ended; null when a signal ended it. */
  code?: number | null;
  signal?: string | null;
  startedAt: number;
  endedAt?: number;
}

/** Plain read-only view of the local `!` runs, so the UI never reads the service object. */
export interface ShellSnapshot {
  running: boolean;
  blocks: readonly ShellBlock[];
}

/** What one shell controller needs from its owner. */
export interface ShellHost {
  /** Repaint after output or a status change. */
  publish(): void;
  /** Client working directory the command runs in. */
  cwd(): string;
  /** Environment for the child, already stripped of client credentials. */
  env(): NodeJS.ProcessEnv;
  /** Newest durable sequence of the selected session, so a block stays where it happened. */
  anchor(): number;
}

/** Owns the `!` commands of this client process: one at a time, bounded, killable. */
export class ShellController {
  private readonly blocks: ShellBlock[] = [];
  private readonly bytes = new WeakMap<ShellBlock, number>();
  private nextId = 1;
  private task: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private lastPublish = 0;

  constructor(private readonly host: ShellHost, /** Whether `!` is allowed at all. */
    readonly enabled = true) {}

  /** Runs in creation order, oldest first; the newest is what the transcript shows at its end. */
  get runs(): readonly ShellBlock[] { return this.blocks; }

  /** Whether a command is still running. */
  get running(): boolean { return this.blocks.some(block => block.status === 'running'); }

  /** The plain snapshot `AppState.shell` publishes; blocks stay owned here. */
  snapshot(): ShellSnapshot { return { running: this.running, blocks: this.blocks }; }

  /** Start one command.
   *
   * One command runs at a time: a second `!` while the first is live is refused rather than queued,
   * because the transcript shows a single result block and the reader can stop the first with Ctrl+C.
   * @param command - Command line typed after `!`.
   * @returns The block created for it.
   */
  start(command: string): ShellBlock {
    if (!this.enabled) throw new Error('Shell commands are disabled (--no-shell or DSHT_NO_SHELL=1)');
    if (this.task) throw new Error('A shell command is already running; Ctrl+C stops it');
    const id = this.nextId++;
    const block: ShellBlock = { id, kind: 'shell', source: localSourceId(id), command, lines: [], dropped: 0,
      status: 'running', startedAt: Date.now(), anchor: this.host.anchor() };
    this.blocks.push(block);
    while (this.blocks.length > BLOCK_LIMIT) this.blocks.shift();
    this.bytes.set(block, 0);
    const abort = new AbortController();
    this.abort = abort;
    this.publish(true);
    const task = runShell(command, {
      cwd: this.host.cwd(), env: this.host.env(), signal: abort.signal,
      onLine: (line, stream: ShellStream) => this.append(block, line),
    }).then(exit => {
      block.status = 'exited'; block.code = exit.code; block.signal = exit.signal; block.endedAt = Date.now();
    }, error => {
      block.status = 'exited'; block.code = null;
      this.append(block, `! ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (this.abort === abort) this.abort = undefined;
      if (this.task === task) this.task = undefined;
      this.publish(true);
    });
    this.task = task;
    return block;
  }

  /** Stop the running command: its process group gets SIGTERM, then SIGKILL after a grace period.
   * @returns Whether a run was stopped.
   */
  cancel(): boolean {
    if (!this.abort) return false;
    this.abort.abort();
    return true;
  }

  /** Echo one client command as a local block, so the transcript holds a bar for it.
   *
   * Nothing runs and nothing is retained: the bar exists to be read and clicked, and the application
   * links it to a readable source afterwards (`link`). A command that only fills a composer frame
   * never reaches here, so the transcript does not collect bars for forms that were never run.
   * @param command - The command line as the operator submitted it.
   * @param source - Readable source the bar opens, when one already exists; `link` adds a later one.
   * @returns The block created for it.
   */
  note(command: string, source?: string): ShellBlock {
    const block: ShellBlock = { id: this.nextId++, kind: 'note', command, lines: [], dropped: 0,
      status: 'exited', startedAt: Date.now(), endedAt: Date.now(), anchor: this.host.anchor(),
      ...(source === undefined ? {} : { source }) };
    this.blocks.push(block);
    while (this.blocks.length > BLOCK_LIMIT) this.blocks.shift();
    this.publish(true);
    return block;
  }

  /** Point the newest note at a readable source, so its bar opens what the run is doing now. */
  link(source: string): void {
    const note = [...this.blocks].reverse().find(block => block.kind === 'note');
    if (note === undefined || note.source === source) return;
    note.source = source;
    this.publish(true);
  }

  /** One run's retained output, with dropped lines made explicit.
   * @param id - Run to read; defaults to the newest.
   * @returns The text, or undefined when the run is unknown.
   */
  output(id?: number): string | undefined {
    const block = id === undefined ? this.blocks.at(-1) : this.blocks.find(item => item.id === id);
    if (!block) return undefined;
    const head = block.dropped > 0 ? [`… ${block.dropped} earlier lines dropped …`] : [];
    return [...head, ...block.lines].join('\n');
  }

  /** Stop the running command and wait for it, so no child outlives this client. */
  async stop(): Promise<void> {
    this.cancel();
    await this.task;
    while (this.running) await delay(20);
  }

  /** Append one output line, trimming the block to its budgets from the front. */
  private append(block: ShellBlock, line: string): void {
    block.lines.push(line);
    let bytes = (this.bytes.get(block) ?? 0) + line.length * 2;
    while (block.lines.length > BLOCK_LINES || bytes > BLOCK_BYTES) {
      if (block.lines.length === 1) break;
      bytes -= block.lines.shift()!.length * 2;
      block.dropped++;
    }
    this.bytes.set(block, bytes);
    this.publish(false);
  }

  /** Repaint, at most once per interval unless the change is a status change. */
  private publish(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastPublish < PUBLISH_INTERVAL_MS) return;
    this.lastPublish = now;
    this.host.publish();
  }
}
