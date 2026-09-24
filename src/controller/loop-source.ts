/** Keep the runtime loop.yaml in the configuration directory, merging shipped records into it. */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument, stringify } from 'yaml';
import { LOOP_PROMPTS } from './loop-prompts.generated.ts';
import { validateLoopOverlayPrompts, validateLoopPrompts } from './loop-prompts-schema.ts';
import { createPrivateFile, ensureDirectory, readText, writePrivateFile } from '../storage/index.ts';
import type { LoopSourceInfo } from '../contracts.ts';
import type { LoopProtocolText, LoopPromptSource } from './loop-prompts-schema.ts';

/** A user file: a whole document in shape, any part of it in content. */
export interface LoopOverlaySource {
  readonly version: number;
  /** Global defaults this file moves; each field it omits keeps the shipped value. */
  readonly defaults?: { readonly score?: number; readonly tries?: number };
  /** Records this file adds or replaces, keyed by the name `/loop` takes. */
  readonly protocols?: Readonly<Record<string, LoopProtocolText>>;
}

/** The records one process runs, and where they came from. */
export interface LoopSourceLoad {
  /** The complete table read back from the configuration file. */
  source: LoopPromptSource;
  /** Which files were read, what the operator changed, and any note for them. */
  info: LoopSourceInfo;
}

/** Where the records come from for one process. */
export interface LoopSourceOptions {
  /** Alternate runtime file, from `DSHT_LOOP_FILE`. */
  overlayFile?: string;
  /** Configuration directory holding the default runtime `loop.yaml`. */
  configDirectory: string;
  /** Shipped file to read; defaults to the `loop.yaml` beside the package entry point. */
  builtinFile?: string;
  /** Table used when the shipped file cannot be read; defaults to the compiled-in one. */
  fallback?: LoopPromptSource;
}

/** Path of the `loop.yaml` shipped beside this module.
 *
 * The path is relative to the module, so it resolves both in the source tree (`src/controller/`) and
 * in the published build (`dist/controller/`), exactly as the version read in `cli/dsht.tsx` does.
 * @returns Absolute path to the shipped record file.
 */
export function shippedLoopFile(): string {
  return fileURLToPath(new URL('../../loop.yaml', import.meta.url));
}

/** The runtime file a process reads.
 *
 * An explicit file wins over the configuration directory: it is how a script or a second checkout
 * points at another set of records without moving the one the interactive client uses.
 * @param options - Resolved options.
 * @returns Runtime file path.
 */
export function loopOverlayFile(options: LoopSourceOptions): string {
  return options.overlayFile ?? join(options.configDirectory, 'loop.yaml');
}

/** Digest of the shipped table last merged into a particular runtime file. */
interface LoopSeed {
  version: 1;
  defaults: { score: number; tries: number };
  records: Record<string, string>;
}

function seedFor(source: LoopPromptSource): LoopSeed {
  return { version: 1, defaults: { ...source.defaults },
    records: Object.fromEntries(Object.entries(source.protocols).map(([name, record]) => [name, digestOf(record)])) };
}

function seedFile(path: string): string { return `${path}.seed.json`; }

async function readSeed(path: string): Promise<LoopSeed | undefined> {
  const raw = await readText(path);
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as LoopSeed;
    if (value?.version === 1 && value.defaults && value.records && typeof value.records === 'object') return value;
  } catch { /* An invalid stamp cannot make the user's configuration unreadable. */ }
  return undefined;
}

/** Update unedited shipped fields while keeping user changes and additions. */
function mergeRuntime(builtin: LoopPromptSource, file: LoopOverlaySource, path: string, previous?: LoopSeed):
{ source: LoopPromptSource; overridden: string[]; added: string[]; warnings: string[] } {
  const overridden: string[] = [], added: string[] = [], warnings: string[] = [];
  const protocols: Record<string, LoopProtocolText> = { ...builtin.protocols };
  for (const [name, record] of Object.entries(file.protocols ?? {})) {
    const shipped = builtin.protocols[name];
    if (shipped === undefined) { protocols[name] = record; added.push(name); continue; }
    const currentDigest = digestOf(shipped);
    const baseline = previous?.records[name] ?? currentDigest;
    if (digestOf(record) === baseline || digestOf(record) === currentDigest) continue;
    protocols[name] = record;
    overridden.push(name);
    if (previous?.records[name] !== undefined && previous.records[name] !== currentDigest) {
      warnings.push(`Your ${name} in ${path} replaces a shipped record that changed in this version; the shipped update is not applied to your copy.`);
    }
  }
  const defaults = { ...builtin.defaults };
  for (const key of ['score', 'tries'] as const) {
    const value = file.defaults?.[key];
    if (value !== undefined && value !== builtin.defaults[key]
      && value !== (previous?.defaults[key] ?? builtin.defaults[key])) defaults[key] = value;
  }
  return { source: { version: 1, defaults, protocols }, overridden, added, warnings };
}

/** Create or merge the configuration file, then read it as the one runtime source.
 * @param options - Resolution options.
 * @returns The merged records, their sources and the notes to show the operator.
 * @throws when the runtime file is not a valid loop file.
 */
export async function loadLoopSource(options: LoopSourceOptions): Promise<LoopSourceLoad> {
  const fallback = options.fallback ?? (LOOP_PROMPTS as unknown as LoopPromptSource);
  const warnings: string[] = [];
  const shipped = await readShipped(options.builtinFile ?? shippedLoopFile(), fallback, warnings);
  const overlayPath = loopOverlayFile(options);
  await ensureDirectory(dirname(overlayPath));
  const initial = await readText(overlayPath);
  if (initial === undefined) {
    await createPrivateFile(overlayPath, shipped.raw ?? stringify(shipped.source));
  }
  const raw = await readText(overlayPath);
  if (raw === undefined) throw new Error(`Cannot read loop records at ${overlayPath}`);
  const overlay = parseOverlay(overlayPath, raw);
  const previous = await readSeed(seedFile(overlayPath));
  const merged = mergeRuntime(shipped.source, overlay, overlayPath, previous);
  const recordChanged = (name: string, record: LoopProtocolText): boolean =>
    overlay.protocols?.[name] === undefined || digestOf(overlay.protocols[name]) !== digestOf(record);
  const changed = (['score', 'tries'] as const).some(key => overlay.defaults?.[key] !== merged.source.defaults[key])
    || Object.entries(merged.source.protocols).some(([name, record]) =>
      recordChanged(name, record));
  if (changed) {
    const document = parseDocument(raw);
    for (const key of ['score', 'tries'] as const) {
      if (overlay.defaults?.[key] !== merged.source.defaults[key]) document.setIn(['defaults', key], merged.source.defaults[key]);
    }
    for (const [name, record] of Object.entries(merged.source.protocols)) {
      if (recordChanged(name, record)) document.setIn(['protocols', name], record);
    }
    await writePrivateFile(overlayPath, document.toString());
  }
  const stamp = `${JSON.stringify(seedFor(shipped.source), null, 2)}\n`;
  if (await readText(seedFile(overlayPath)) !== stamp) await writePrivateFile(seedFile(overlayPath), stamp);
  const runtime = await readText(overlayPath);
  if (runtime === undefined) throw new Error(`Cannot read loop records at ${overlayPath}`);
  const source = parse(runtime);
  const errors = validateLoopPrompts(source);
  if (errors.length > 0) throw new Error(`${overlayPath}:\n- ${errors.join('\n- ')}`);
  return {
    source: source as LoopPromptSource,
    info: {
      ...(shipped.file === undefined ? {} : { builtin: shipped.file }),
      file: overlayPath,
      overridden: merged.overridden,
      added: merged.added,
      warnings: [...warnings, ...merged.warnings],
    },
  };
}

/** Read and validate the shipped file, falling back to the compiled-in table.
 * @param path - Shipped file path.
 * @param fallback - Table to use when the file cannot be read or is invalid.
 * @param warnings - Collector for the note that explains a fallback.
 * @returns The shipped records and the file they came from, if any.
 */
async function readShipped(path: string, fallback: LoopPromptSource, warnings: string[]):
Promise<{ source: LoopPromptSource; file?: string; raw?: string }> {
  const raw = await readText(path);
  if (raw === undefined) {
    warnings.push(`Cannot read the shipped records at ${path}; using the table compiled into this build.`);
    return { source: fallback };
  }
  let parsed: unknown;
  try { parsed = parse(raw); }
  catch (error) {
    warnings.push(`Cannot parse the shipped records at ${path}: ${message(error)}. Using the table compiled into this build.`);
    return { source: fallback };
  }
  const errors = validateLoopPrompts(parsed);
  if (errors.length > 0) {
    warnings.push(`The shipped records at ${path} are invalid: ${errors.join('; ')}. Using the table compiled into this build.`);
    return { source: fallback };
  }
  return { source: parsed as LoopPromptSource, file: path, raw };
}

/** Parse one runtime file before merging, refusing anything the renderer would misread.
 * @param path - Runtime file path, used in every message.
 * @param raw - File contents.
 * @returns The parsed document.
 * @throws when the file is not valid YAML or does not satisfy the overlay schema.
 */
function parseOverlay(path: string, raw: string): LoopOverlaySource {
  let parsed: unknown;
  try { parsed = parse(raw); }
  catch (error) { throw new Error(`${path}: ${message(error)}`); }
  const errors = validateLoopOverlayPrompts(parsed);
  if (errors.length > 0) throw new Error(`${path}:\n- ${errors.join('\n- ')}`);
  return parsed as LoopOverlaySource;
}

/** Content digest of one record, stable across key order because it hashes the serialized record.
 * @param record - Shipped record.
 * @returns Lowercase hex sha256.
 */
function digestOf(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(record))).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, sortKeys(entry)]));
  }
  return value;
}

/** Readable text for anything thrown. */
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
