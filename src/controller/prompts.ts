/** User-saved shortcut prompts, persisted in one private JSON file.
 *
 * The list belongs to the operator rather than to a session or a host, so it survives session
 * switches, reconnects and machine restarts. Without a configured path the list still works for the
 * current run, which is what tests and `--help` runs use.
 */
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { SavedPrompt } from '../contracts.ts';
import { ensureDirectory, readText, writePrivateFile } from '../storage/index.ts';
import { errorText } from '../transport/wire.ts';

/** Largest single saved prompt; a shortcut is meant to be reusable, not a document store. */
export const MAX_PROMPT_CHARS = 8 * 1024;
/** Most saved prompts one client keeps. */
export const MAX_SAVED_PROMPTS = 500;
/** On-disk shape this build writes. */
const FILE_VERSION = 1;

/** Read and persist shortcut prompts; an absent path keeps them in memory for this run.
 *
 * Mutations are queued: a save, edit or delete computes and writes inside the queue, so two rapid
 * commands can never interleave their writes and leave the file disagreeing with the list.
 */
export class PromptStore {
  private items: SavedPrompt[] = [];
  private loaded = false;
  /** Tail of the mutation queue; the next operation starts only after the previous one settled. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Last read or write failure, shown by the saved-prompt picker. */
  error: string | undefined;
  constructor(readonly path?: string) {}

  /** Entries in the order they were saved, oldest first. */
  get list(): readonly SavedPrompt[] { return this.items; }

  /** Read the file once; a missing file is simply an empty list.
   *
   * A malformed document leaves the list empty and is reported through `error` rather than thrown,
   * because a broken shortcuts file must not stop the client from starting.
   * @returns Whether the result differs from the empty default, so a caller knows to republish.
   */
  async load(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.path === undefined || this.loaded) return false;
      this.loaded = true;
      try {
        const raw = await readText(this.path);
        if (raw === undefined) return false;
        this.items = promptsFrom(JSON.parse(raw));
        this.error = undefined;
        return this.items.length > 0;
      } catch (error) {
        this.error = `Saved prompts could not be read: ${errorText(error)}`;
        return true;
      }
    });
  }

  /** Add one prompt; a text already saved is returned instead of duplicated.
   * @param value - Prompt text exactly as the user typed it.
   * @returns The saved entry.
   */
  async save(value: string): Promise<SavedPrompt> {
    return this.enqueue(async () => {
      const text = checked(value);
      const existing = this.items.find(item => item.text === text);
      if (existing) return existing;
      if (this.items.length >= MAX_SAVED_PROMPTS) throw new Error(`Saved prompts are limited to ${MAX_SAVED_PROMPTS} entries`);
      const prompt: SavedPrompt = { id: randomUUID(), text };
      await this.commit([...this.items, prompt]);
      return prompt;
    });
  }

  /** Replace one saved prompt's text.
   * @param id - Entry identity.
   * @param value - Replacement text.
   * @returns False when the entry no longer exists.
   */
  async update(id: string, value: string): Promise<boolean> {
    return this.enqueue(async () => {
      const text = checked(value);
      if (!this.items.some(item => item.id === id)) return false;
      await this.commit(this.items.map(item => item.id === id ? { id, text } : item));
      return true;
    });
  }

  /** Drop one saved prompt.
   * @param id - Entry identity.
   * @returns False when it was already gone.
   */
  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const next = this.items.filter(item => item.id !== id);
      if (next.length === this.items.length) return false;
      await this.commit(next);
      return true;
    });
  }

  /** Queue one operation behind everything already queued, whether or not the last one failed.
   * @param task - Operation to run when it reaches the head of the queue.
   * @returns The operation's own result or failure.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Apply a new list, restoring the previous one when the write fails, so memory follows the file. */
  private async commit(items: SavedPrompt[]): Promise<void> {
    const previous = this.items;
    this.items = items;
    try { await this.persist(); this.error = undefined; }
    catch (error) { this.items = previous; throw error; }
  }

  /** Rewrite the file atomically, creating its directory on first use. */
  private async persist(): Promise<void> {
    if (this.path === undefined) return;
    await ensureDirectory(dirname(this.path));
    await writePrivateFile(this.path, `${JSON.stringify({ version: FILE_VERSION, prompts: this.items }, null, 2)}\n`);
  }
}

/** Trim and bound one submitted prompt.
 * @param value - Raw text after the command.
 * @returns The text to store.
 */
function checked(value: string): string {
  const text = value.trim();
  if (!text) throw new Error('Type a prompt after /prompt');
  if (text.length > MAX_PROMPT_CHARS) throw new Error(`A saved prompt is limited to ${MAX_PROMPT_CHARS} characters`);
  return text;
}

/** Validate the stored document, skipping entries this build cannot use.
 * @param raw - Parsed JSON document.
 * @returns The saved prompts, in file order.
 */
function promptsFrom(raw: unknown): SavedPrompt[] {
  const document = raw as { prompts?: unknown } | null;
  if (!document || typeof document !== 'object' || !Array.isArray(document.prompts)) throw new Error('unsupported prompts file');
  const out: SavedPrompt[] = [];
  for (const entry of document.prompts) {
    const item = entry as { id?: unknown; text?: unknown };
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) continue;
    out.push({ id: item.id, text: item.text });
  }
  return out;
}
