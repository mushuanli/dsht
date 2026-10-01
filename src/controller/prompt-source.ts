/**
 * The two prompt files, and how one process installs and reads them.
 *
 * `prompt.json` in the configuration directory is the **installed** set: it is created from the file
 * shipped in the package the first time a client runs, exactly as `loop.yaml` is, and the operator is
 * not expected to edit it. `prompt.local.json` is the **operator's** file: `/prompt TEXT` writes it, and
 * an entry in it hides the installed entry with the same identity — the same shape as `loop.local.yaml`
 * for loop records.
 *
 * Keeping installation here (rather than in `PromptStore`) means the store only ever reads and writes
 * two named files, and the one-time move of a pre-layering `<state>/prompts.json` has a single home.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateFile, ensureDirectory, readText, writePrivateFile } from '../storage/index.ts';

/** Name of the file shipped beside the package entry point. */
const SHIPPED = 'prompt.json';
/** Name of the installed copy inside the configuration directory. */
export const INSTALLED_PROMPT_FILE = 'prompt.json';
/** Name of the operator's own file inside the configuration directory. */
export const LOCAL_PROMPT_FILE = 'prompt.local.json';

/** Path of the `prompt.json` shipped beside this module.
 *
 * Relative to the module, so it resolves in the source tree (`src/controller/`) and in the published
 * build (`dist/controller/`), exactly as the shipped `loop.yaml` and the version string do.
 * @returns Absolute path to the shipped defaults.
 */
export function shippedPromptFile(): string {
  return fileURLToPath(new URL(`../../${SHIPPED}`, import.meta.url));
}

/** The installed set's path in one configuration directory. */
export function installedPromptFile(configDirectory: string, explicit?: string): string {
  return explicit ?? join(configDirectory, INSTALLED_PROMPT_FILE);
}

/** The operator's file path in one configuration directory. */
export function localPromptFile(configDirectory: string, explicit?: string): string {
  return explicit ?? join(configDirectory, LOCAL_PROMPT_FILE);
}

/** Where the two prompt files of one process are. */
export interface PromptSourcePaths {
  /** Installed defaults; absent keeps them out of the list (tests and `--help` runs). */
  readonly installed?: string;
  /** The operator's own file; absent keeps mutations in memory for this run. */
  readonly local?: string;
}

/** What one process found while installing and reading the two files. */
export interface PromptSourceInfo {
  /** Installed file created from the shipped defaults during this run. */
  readonly created?: string;
  /** Installed file refreshed because the shipped defaults changed during this run. */
  readonly updated?: string;
  /** Entries the refresh moved from the installed file into the operator's own layer. */
  readonly adopted: readonly string[];
  /** Legacy file whose entries moved into the local file during this run. */
  readonly migrated?: string;
  /** Notes to show the operator, in the order they were discovered. */
  readonly warnings: readonly string[];
}

/** One prompt row, as the installer compares and writes them. */
interface StoredPrompt { id: string; text: string; top?: boolean }

/** Keep the installed file equal to the shipped defaults, whatever an earlier run left there.
 *
 * The installed file is *ours*: a release that adds a prompt, or marks one `top`, has to reach an
 * installation that already exists, or the operator silently keeps the old set. So the file is refreshed
 * whenever its content differs from the shipped file — after moving anything it holds that the shipped
 * set does not provide into the operator's own layer, because that is the file their changes belong in
 * (and `PromptStore` then shows them as overrides, in the same places). Nothing is dropped: an entry the
 * local layer already has — by identity or by text — is left alone there.
 * @param options - Configuration directory, shipped file, and any explicit paths.
 * @returns The paths one process reads, plus what the installation did.
 */
export async function installPromptSource(options: {
  configDirectory: string;
  shippedFile?: string;
  installedFile?: string;
  localFile?: string;
}): Promise<{ paths: PromptSourcePaths; info: PromptSourceInfo }> {
  const warnings: string[] = [];
  const installed = installedPromptFile(options.configDirectory, options.installedFile);
  const local = localPromptFile(options.configDirectory, options.localFile);
  await ensureDirectory(dirname(installed));
  const shippedPath = options.shippedFile ?? shippedPromptFile();
  const shipped = readEntries(await readText(shippedPath));
  const present = await readText(installed);
  if (shipped === undefined) {
    if (present === undefined) warnings.push(`Cannot read the shipped prompts at ${shippedPath}; starting with none installed.`);
    return { paths: { installed, local }, info: { adopted: [], warnings } };
  }
  if (present === undefined) {
    await createPrivateFile(installed, serialize(shipped));
    return { paths: { installed, local }, info: { created: installed, adopted: [], warnings } };
  }
  const current = readEntries(present);
  if (current !== undefined && sameEntries(current, shipped)) {
    return { paths: { installed, local }, info: { adopted: [], warnings } };
  }
  const adopted = await adoptIntoLocal(current, shipped, local);
  await writePrivateFile(installed, serialize(shipped));
  if (adopted.length > 0) {
    warnings.push(`Moved ${adopted.length === 1 ? 'a prompt' : `${adopted.length} prompts`} out of ${installed} into ${local}: that file is the installed set, so your own entries belong in the local one.`);
  }
  return { paths: { installed, local }, info: { updated: installed, adopted, warnings } };
}

/** Read one prompt document tolerantly, or undefined when it is absent or unusable. */
function readEntries(raw: string | undefined): StoredPrompt[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const document = JSON.parse(raw) as { prompts?: unknown } | null;
    if (!document || typeof document !== 'object' || !Array.isArray(document.prompts)) return undefined;
    const entries: StoredPrompt[] = [];
    for (const value of document.prompts) {
      const item = value as { id?: unknown; text?: unknown; top?: unknown } | null;
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) continue;
      entries.push({ id: item.id, text: item.text, ...(typeof item.top === 'boolean' ? { top: item.top } : {}) });
    }
    return entries;
  } catch { return undefined; }
}

/** The canonical installed file: the shipped rows, in shipped order, with the markers they carry. */
function serialize(entries: readonly StoredPrompt[]): string {
  return `${JSON.stringify({ version: 1,
    prompts: entries.map(item => ({ id: item.id, text: item.text, ...(item.top === undefined ? {} : { top: item.top }) })) }, null, 2)}\n`;
}

/** Whether two sets of rows are the same prompts in the same order. */
function sameEntries(left: readonly StoredPrompt[], right: readonly StoredPrompt[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]!;
    return item.id === other.id && item.text === other.text && item.top === other.top;
  });
}

/** Move the rows an existing installed file holds but the shipped set does not into the local layer.
 *
 * A row the shipped set no longer provides, and one whose text differs from the shipped row with the same
 * identity, are the operator's. Rows the local file already covers are left alone there.
 * @returns The identities that were moved, in file order.
 */
async function adoptIntoLocal(current: StoredPrompt[] | undefined, shipped: readonly StoredPrompt[], local: string): Promise<string[]> {
  if (current === undefined) return [];
  const shippedById = new Map(shipped.map(item => [item.id, item]));
  const shippedTexts = new Set(shipped.map(item => item.text));
  const mine = current.filter(item => shippedById.get(item.id)?.text !== item.text && !shippedTexts.has(item.text));
  if (mine.length === 0) return [];
  const localRaw = await readText(local);
  const existing = readEntries(localRaw) ?? [];
  const hidden = readHidden(localRaw);
  const known = new Set(existing.map(item => item.id));
  const texts = new Set(existing.map(item => item.text));
  const moved = mine.filter(item => !known.has(item.id) && !texts.has(item.text));
  if (moved.length === 0) return [];
  await ensureDirectory(dirname(local));
  await writePrivateFile(local, `${JSON.stringify({ version: 1, prompts: [...existing, ...moved],
    ...(hidden.length === 0 ? {} : { hidden }) }, null, 2)}\n`);
  return moved.map(item => item.id);
}

/** The hidden identities of one local document, kept when the file is rewritten. */
function readHidden(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  try {
    const document = JSON.parse(raw) as { hidden?: unknown } | null;
    return Array.isArray(document?.hidden) ? document.hidden.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/** One usable entry of a prompt file, as the migration compares them. */
interface MigratablePrompt { id: string; text: string }

/** Move a pre-layering `<state>/prompts.json` into the operator's file, once.
 *
 * The old location was the only prompt file, so its entries belong to the operator — except the ones the
 * installed defaults already provide under the same identity or the same text. Copying those would turn
 * a shipped prompt into a local copy that (a) leads the list instead of staying where `prompt.json` put
 * it and (b) shadows every later shipped update to it, so they are left out. When nothing is left, no
 * local file is created at all and the installed order is what the operator sees.
 *
 * The legacy file is left in place rather than deleted: a rollback to the previous build keeps working,
 * and nothing is lost if this move is interrupted.
 * @param legacy - Old path, typically `<state>/prompts.json`.
 * @param local - Operator's file under the configuration directory.
 * @param installed - Installed defaults to compare against, when one is on disk.
 * @returns The legacy path when entries were moved, undefined when there was nothing to move.
 */
export async function migrateLegacyPromptFile(legacy: string | undefined, local: string | undefined,
  installed?: string): Promise<string | undefined> {
  if (legacy === undefined || local === undefined || legacy === local) return undefined;
  const raw = await readText(legacy);
  if (raw === undefined) return undefined;
  if (await readText(local) !== undefined) return undefined;
  let moved: MigratablePrompt[];
  try {
    moved = await missingFrom(migrateDocument(raw), installed);
  } catch (error) {
    // A malformed legacy file must not stop startup: the operator keeps the file and the client starts
    // with an empty local layer, which `PromptStore` reports through its own `error`.
    return undefined;
  }
  if (moved.length === 0) return undefined;
  await ensureDirectory(dirname(local));
  await writePrivateFile(local, `${JSON.stringify({ version: 1, prompts: moved }, null, 2)}\n`);
  return legacy;
}

/** Keep only the entries the installed file does not already provide. */
async function missingFrom(prompts: MigratablePrompt[], installed: string | undefined): Promise<MigratablePrompt[]> {
  if (installed === undefined) return prompts;
  const raw = await readText(installed);
  if (raw === undefined) return prompts;
  const provided = providedBy(raw);
  return prompts.filter(item => !provided.ids.has(item.id) && !provided.texts.has(item.text));
}

/** Identities and texts one installed file provides, tolerantly: an unreadable file provides nothing. */
function providedBy(raw: string): { ids: Set<string>; texts: Set<string> } {
  try {
    const document = layerPrompts(raw);
    return { ids: new Set(document.map(item => item.id)), texts: new Set(document.map(item => item.text)) };
  } catch { return { ids: new Set(), texts: new Set() }; }
}

/** Read the prompt rows of one stored document, skipping rows this build cannot use. */
function layerPrompts(raw: string): MigratablePrompt[] {
  const document = JSON.parse(raw) as { prompts?: unknown } | null;
  if (!document || typeof document !== 'object' || !Array.isArray(document.prompts)) throw new Error('unsupported prompts file');
  const prompts: MigratablePrompt[] = [];
  for (const entry of document.prompts) {
    const item = entry as { id?: unknown; text?: unknown } | null;
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.text !== 'string' || !item.text.trim()) continue;
    prompts.push({ id: item.id, text: item.text });
  }
  return prompts;
}

/** Rewrite one legacy document into the entries the migration may carry over. */
function migrateDocument(raw: string): MigratablePrompt[] {
  return layerPrompts(raw);
}
