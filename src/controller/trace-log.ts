/** Append-only diagnostic trace of connection, screen and selection transitions.
 *
 * The memory log answers "is retained content growing"; this log answers "why did the client end up
 * where it is" — every reconnect, picker and selection change is written with the values it moved
 * between, so a jump that only happens in the field can be read instead of guessed at. Events carry
 * identifiers and screen names only, never prompt, tool or session text, and a failing log stops
 * itself instead of breaking the client.
 */
import { dirname } from 'node:path';
import { appendPrivateFile, createPrivateFile, ensureDirectory, readText, writePrivateFile } from '../storage/index.ts';
import { errorText, type ObjectValue } from '../transport/wire.ts';

/** Events kept; reaching the cap rewrites the file with just these lines. */
const KEEP_EVENTS = 2000;
/** First line of the file, so a reader knows what the lines are without reading the source. */
const HEADER = '# dsht trace: one JSON event per line, oldest first\n';

/** Serialized append-only trace; the file never exceeds twice `KEEP_EVENTS` lines.
 *
 * Writes are chained rather than awaited by the caller, because transitions are published from
 * synchronous state updates. A failed write is remembered and reported on the next event instead of
 * throwing into the controller.
 */
export class TraceLog {
  private queue: Promise<void> = Promise.resolve();
  private lines: string[] = [];
  private directoryEnsured = false;
  /** Last write failure, when the log stopped growing. */
  error: string | undefined;
  constructor(readonly path: string | undefined) {}

  /** Append one event; an absent path makes this a no-op. */
  record(event: ObjectValue): void {
    if (this.path === undefined) return;
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`;
    this.lines.push(line);
    this.queue = this.queue.then(() => this.append(line))
      .catch(error => { this.error = errorText(error); });
  }

  /** Wait for queued writes, so a shutdown does not lose the last events. */
  async settle(): Promise<void> { await this.queue; }

  /** Write one line, then bound the file when the cap is reached. */
  private async append(line: string): Promise<void> {
    if (!this.directoryEnsured) { await ensureDirectory(dirname(this.path!)); this.directoryEnsured = true; }
    // Seeding a header only affects a new file; an existing trace is appended to.
    await createPrivateFile(this.path!, HEADER);
    await appendPrivateFile(this.path!, line);
    this.error = undefined;
    if (this.lines.length >= KEEP_EVENTS) await this.compact();
  }

  /** Rewrite the file with the header and the newest kept lines, bounding its size.
   *
   * Older runs are not read back: `lines` is what this process appended, which bounds both the file
   * and the read that rewrites it.
   */
  private async compact(): Promise<void> {
    const kept = this.lines.slice(-KEEP_EVENTS);
    await writePrivateFile(this.path!, HEADER + kept.join(''));
    this.lines = kept;
  }
}

/** Read a trace back, so a test or a diagnostic tool can assert what was recorded.
 * @param path - Trace file to read.
 * @returns Every non-empty line, oldest first.
 */
export async function readTrace(path: string): Promise<string[]> {
  const text = await readText(path);
  return text === undefined ? [] : text.split('\n').filter(line => line !== '');
}
