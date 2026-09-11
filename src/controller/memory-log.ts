/** Runtime memory samples appended to one bounded local file for diagnosing growth over a long run. */
import { appendPrivateFile, createPrivateFile, writePrivateFile } from '../storage/index.ts';
import { errorText, type ObjectValue } from '../transport/wire.ts';

/** Time between automatic samples. */
const SAMPLE_INTERVAL_MS = 30_000;
/** Samples kept; reaching the cap rewrites the file with just these lines. */
const KEEP_SAMPLES = 1000;
/** First line of the file, so an empty or rewritten log still explains itself. */
const HEADER = '# dsht memory samples: one JSON object per line, oldest first\n';

/** Append-only memory log; the file never exceeds twice `KEEP_SAMPLES` lines.
 *
 * The log exists to answer "is retained content growing, or is this just V8's high-water mark",
 * so each sample records the process counters next to the client's retained window and the
 * controller state that decides whether that window is being reclaimed. Samples contain counts
 * and sizes only, never prompt, tool, or session text. A failing log stops itself instead of
 * breaking the client.
 */
export class MemoryLog {
  private timer: ReturnType<typeof setInterval> | undefined;
  private appended: string[] = [];
  private writing = false;
  /** Last write failure, when the log stopped itself. */
  error: string | undefined;
  constructor(readonly path: string | undefined, private readonly sampleSource: () => ObjectValue) {}

  /** Write the header into a new file, then sample once; a missing or unwritable path is reported
   * by that first sample instead of here.
   */
  private async begin(): Promise<void> {
    if (this.path === undefined) return;
    try { await createPrivateFile(this.path, HEADER); } catch { /* the sample below reports it */ }
    await this.sample();
  }

  /** Sample once now and then every `SAMPLE_INTERVAL_MS`; absent when no path was configured. */
  start(): void {
    if (this.path === undefined || this.timer !== undefined) return;
    void this.begin();
    this.timer = setInterval(() => { void this.sample(); }, SAMPLE_INTERVAL_MS);
  }

  /** Stop sampling and rewrite the file with its retained window. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.compact();
  }

  /** Append one sample line, skipping overlapping calls.
   *
   * A repeated failure would be noise, so the first one stops the timer and leaves the client
   * running; the log is diagnostics, not a feature the terminal depends on.
   */
  async sample(): Promise<void> {
    if (this.path === undefined || this.writing) return;
    this.writing = true;
    try {
      const line = `${JSON.stringify(this.sampleSource())}\n`;
      await appendPrivateFile(this.path, line);
      this.appended.push(line);
      this.error = undefined;
      if (this.appended.length >= KEEP_SAMPLES) await this.compact();
    } catch (error) {
      this.error = errorText(error);
      clearInterval(this.timer);
      this.timer = undefined;
    } finally { this.writing = false; }
  }

  /** Rewrite the file with the header and the newest kept lines, bounding its size. */
  private async compact(): Promise<void> {
    if (this.path === undefined || this.appended.length === 0) return;
    const lines = this.appended.slice(-KEEP_SAMPLES);
    try {
      await writePrivateFile(this.path, HEADER + lines.join(''));
      this.appended = lines;
    } catch (error) {
      // Appending continues to the existing file, so a failed rewrite only delays the bound.
      this.error = errorText(error);
    }
  }
}
