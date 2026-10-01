/** Saved shortcut prompts, layered from the installed set and the operator's own file.
 *
 * Two files, one list. `prompt.json` holds the defaults installed from the package; `prompt.local.json`
 * holds the operator's entries and is the only file mutations write. An entry in the local file hides
 * the installed entry with the same identity, and an id the operator removed from the installed set is
 * remembered as hidden — so the installed file stays exactly as it was installed while the list the
 * operator sees is theirs.
 *
 * The list belongs to the operator rather than to a session or a host, so it survives session switches,
 * reconnects and machine restarts. Without configured paths it still works for the current run, which is
 * what tests and `--help` runs use.
 */
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { SavedPrompt } from '../contracts.ts';
import { ensureDirectory, readText, writePrivateFile } from '../storage/index.ts';
import { errorText } from '../transport/wire.ts';
import type { PromptSourcePaths } from './prompt-source.ts';

/** Largest single saved prompt; a shortcut is meant to be reusable, not a document store. */
export const MAX_PROMPT_CHARS = 8 * 1024;
/** Most saved prompts the operator's own file keeps. */
export const MAX_SAVED_PROMPTS = 500;
/** On-disk shape this build writes. */
const FILE_VERSION = 1;

/** One file's contents, before layering. */
interface Layer {
  prompts: SavedPrompt[];
  /** Installed identities the operator removed, kept so the removal survives a restart. */
  hidden: string[];
}

/** Read and persist shortcut prompts across the installed and local layers.
 *
 * Mutations are queued: a save, edit or delete computes and writes inside the queue, so two rapid
 * commands can never interleave their writes and leave the file disagreeing with the list.
 */
export class PromptStore {
  private installed: Layer = { prompts: [], hidden: [] };
  private local: Layer = { prompts: [], hidden: [] };
  private loaded = false;
  /** Tail of the mutation queue; the next operation starts only after the previous one settled. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Last read or write failure, shown by the saved-prompt picker. */
  error: string | undefined;
  constructor(readonly paths: PromptSourcePaths = {}) {}

  /** The list the operator sees, in the order the files decide.
   *
   * Three groups, each in its own file order:
   *
   * 1. **pinned** entries — a record marked `top: true` in either file, the operator's own additions
   *    first and then the installed ones, with an installed record's place kept for the local entry that
   *    overrides it, so a pinned default stays pinned while showing the operator's text;
   * 2. the operator's **unpinned additions** — the entries only they have;
   * 3. the installed file's remaining order, an overridden record shown in its own place.
   *
   * `prompt.json` is the backbone, because it is the order whoever wrote the defaults chose: editing a
   * default never reshuffles the list. `top: false` in the operator's file demotes a pinned default,
   * which is the one way to remove a shipped pin short of deleting the prompt. A local entry that is
   * identical to the installed one (same identity and text, which is what a migration produces) counts
   * as neither: it neither leads nor shadows, so a shipped update still reaches the list.
   */
  get list(): readonly SavedPrompt[] {
    const installedById = new Map(this.installed.prompts.map(item => [item.id, item]));
    const hidden = new Set(this.local.hidden);
    // Only entries that carry information of their own are the operator's: a copy whose identity, text
    // and marker all match the installed entry (what a migration produces) says nothing new, and treating
    // it as an override would shadow later shipped updates to that prompt.
    const custom = this.local.prompts.filter(item => {
      const installed = installedById.get(item.id);
      return installed === undefined || installed.text !== item.text || installed.top !== item.top;
    });
    const byId = new Map(custom.map(item => [item.id, item]));
    const byText = new Map(custom.map(item => [item.text, item]));
    const anchored = (item: SavedPrompt): boolean =>
      this.installed.prompts.some(entry => entry.id === item.id || entry.text === item.text);
    const pinnedLocal: SavedPrompt[] = [];
    const extraLocal: SavedPrompt[] = [];
    const shown = new Set<string>();
    for (const item of custom) {
      if (anchored(item)) continue;
      (item.top === true ? pinnedLocal : extraLocal).push({ ...item });
      shown.add(item.id);
    }
    const pinnedInstalled: SavedPrompt[] = [];
    const backbone: SavedPrompt[] = [];
    for (const item of this.installed.prompts) {
      if (hidden.has(item.id)) continue;
      const override = byId.get(item.id) ?? byText.get(item.text);
      if (override !== undefined) shown.add(override.id);
      const row = override === undefined ? { ...item, installed: true as const } : { ...override };
      const pinned = (item.top === true || override?.top === true) && override?.top !== false;
      (pinned ? pinnedInstalled : backbone).push(row);
    }
    // Defensive: an entry that matched nothing is still shown, because a saved prompt the operator
    // cannot see is worse than one extra row.
    for (const item of custom) if (!shown.has(item.id)) extraLocal.push({ ...item });
    return [...pinnedLocal, ...pinnedInstalled, ...extraLocal, ...backbone];
  }

  /** Read both files once; a missing file is simply an empty layer.
   *
   * A malformed document leaves that layer empty and is reported through `error` rather than thrown,
   * because a broken shortcuts file must not stop the client from starting.
   * @returns Whether the result differs from the empty default, so a caller knows to republish.
   */
  async load(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.loaded) return false;
      if (this.paths.installed === undefined && this.paths.local === undefined) return false;
      this.loaded = true;
      const failures: string[] = [];
      this.installed = await this.readLayer(this.paths.installed, failures);
      this.local = await this.readLayer(this.paths.local, failures);
      this.error = failures.length > 0 ? failures.join(' · ') : undefined;
      return this.list.length > 0 || failures.length > 0;
    });
  }

  /** Add one prompt; a text already in the list is returned instead of duplicated.
   * @param value - Prompt text exactly as the user typed it.
   * @returns The saved entry.
   */
  async save(value: string): Promise<SavedPrompt> {
    return this.enqueue(async () => {
      const text = checked(value);
      const existing = this.list.find(item => item.text === text);
      if (existing) return existing;
      if (this.local.prompts.length >= MAX_SAVED_PROMPTS) throw new Error(`Saved prompts are limited to ${MAX_SAVED_PROMPTS} entries`);
      const prompt: SavedPrompt = { id: randomUUID(), text };
      // Saving the text of an installed entry the operator had hidden makes it visible again, as their
      // own: the entry they asked for is the one they just typed.
      const unhidden = this.installed.prompts.find(item => item.text === text);
      const hidden = unhidden === undefined ? this.local.hidden : this.local.hidden.filter(id => id !== unhidden.id);
      await this.commitLocal({ prompts: [...this.local.prompts, prompt], hidden });
      return prompt;
    });
  }

  /** Replace one prompt's text, creating a local override when the entry is an installed one.
   * @param id - Entry identity.
   * @param value - Replacement text.
   * @returns False when no entry has that identity.
   */
  async update(id: string, value: string): Promise<boolean> {
    return this.enqueue(async () => {
      const text = checked(value);
      const mine = this.local.prompts.find(item => item.id === id);
      if (mine !== undefined) {
        // The entry's own `top` marker survives an edit; an edit is about the text.
        await this.commitLocal({ ...this.local,
          prompts: this.local.prompts.map(item => item.id === id ? { ...item, text } : item) });
        return true;
      }
      if (!this.installed.prompts.some(item => item.id === id)) return false;
      // An installed default the operator edits becomes their own entry under the same identity; the
      // installed file is never rewritten.
      // Any hidden marker for this identity is now moot: the local entry is what the list shows.
      await this.commitLocal({ prompts: [...this.local.prompts, { id, text }],
        hidden: this.local.hidden.filter(entry => entry !== id) });
      return true;
    });
  }

  /** Drop one prompt.
   *
   * Deleting a row means the row is gone, whatever layer it came from: an installed entry — or the
   * operator's own override of one — is remembered as hidden, so it cannot reappear on the next run.
   * Saving that text again is how a default comes back (`save` clears the marker).
   * @param id - Entry identity.
   * @returns False when it was already gone.
   */
  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const mine = this.local.prompts.some(item => item.id === id);
      const shipped = this.installed.prompts.some(item => item.id === id);
      if (!mine && (!shipped || this.local.hidden.includes(id))) return false;
      await this.commitLocal({
        prompts: this.local.prompts.filter(item => item.id !== id),
        hidden: shipped && !this.local.hidden.includes(id) ? [...this.local.hidden, id] : this.local.hidden,
      });
      return true;
    });
  }

  /** Read one layer, reporting a failure instead of throwing so the other layer still loads. */
  private async readLayer(path: string | undefined, failures: string[]): Promise<Layer> {
    if (path === undefined) return { prompts: [], hidden: [] };
    try {
      const raw = await readText(path);
      if (raw === undefined) return { prompts: [], hidden: [] };
      return layerFrom(JSON.parse(raw));
    } catch (error) {
      failures.push(`Saved prompts could not be read at ${path}: ${errorText(error)}`);
      return { prompts: [], hidden: [] };
    }
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

  /** Apply a new local layer, restoring the previous one when the write fails, so memory follows the file. */
  private async commitLocal(layer: Layer): Promise<void> {
    const previous = this.local;
    this.local = layer;
    try { await this.persist(); this.error = undefined; }
    catch (error) { this.local = previous; throw error; }
  }

  /** Rewrite the local file atomically, creating its directory on first use. */
  private async persist(): Promise<void> {
    if (this.paths.local === undefined) return;
    await ensureDirectory(dirname(this.paths.local));
    await writePrivateFile(this.paths.local, `${JSON.stringify({ version: FILE_VERSION,
      prompts: this.local.prompts.map(item => ({ id: item.id, text: item.text,
        ...(item.top === undefined ? {} : { top: item.top }) })),
      ...(this.local.hidden.length === 0 ? {} : { hidden: this.local.hidden }) }, null, 2)}\n`);
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

/** Validate one stored document, skipping entries this build cannot use.
 * @param raw - Parsed JSON document.
 * @returns The layer's entries and hidden identities, in file order.
 */
function layerFrom(raw: unknown): Layer {
  const document = raw as { prompts?: unknown; hidden?: unknown } | null;
  if (!document || typeof document !== 'object' || !Array.isArray(document.prompts)) throw new Error('unsupported prompts file');
  const prompts: SavedPrompt[] = [];
  for (const entry of document.prompts) {
    const item = entry as { id?: unknown; text?: unknown; top?: unknown };
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) continue;
    prompts.push({ id: item.id, text: item.text, ...(typeof item.top === 'boolean' ? { top: item.top } : {}) });
  }
  const hidden = Array.isArray(document.hidden) ? document.hidden.filter((id): id is string => typeof id === 'string') : [];
  return { prompts, hidden };
}
