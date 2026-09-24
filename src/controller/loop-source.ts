/** Resolve the records `/loop` runs: the shipped loop.yaml, a user file layered over it, and the
 * table compiled into this build as the last resort.
 *
 * The loop record is configuration, not code: the shipped file travels with the package and is read
 * at startup, so a fix to a rubric reaches an install without a TypeScript build, and `DSHT_LOOP_FILE`
 * or `<config>/loop.yaml` lets an operator add a record or correct one without forking the project.
 *
 * Layering is per record, never per file. A user file that overrides one record leaves every other
 * shipped record following the package, so the next version's fixes still arrive; a whole-file
 * replacement would freeze the shipped records at whatever the operator copied. A record the user does
 * override can never be updated for them — the tool cannot know whether their copy is deliberate — so
 * the shipped record's digest is stamped under the state directory and a change is reported, not
 * applied.
 *
 * `loop-prompts.generated.ts` stays as the fallback: a package whose loop.yaml is missing or corrupt
 * still starts on the records this build was compiled with, which is also what keeps the module
 * self-contained for a test that must not touch the filesystem.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { LOOP_PROMPTS } from './loop-prompts.generated.ts';
import { validateLoopOverlayPrompts, validateLoopPrompts } from './loop-prompts-schema.ts';
import { ensureDirectory, readText, writePrivateFile } from '../storage/index.ts';
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
  /** The merged table the renderer reads: shipped records, then the user's on top. */
  source: LoopPromptSource;
  /** Which files were read, what the user's file changed, and any note for the operator. */
  info: LoopSourceInfo;
}

/** Where the records come from for one process. */
export interface LoopSourceOptions {
  /** Overlay to read instead of `<configDirectory>/loop.yaml`, from `--loop-file`/`DSHT_LOOP_FILE`. */
  overlayFile?: string;
  /** Configuration directory holding `loop.yaml` when no explicit file is given. */
  configDirectory: string;
  /** State directory holding the override stamp; omit to skip drift reporting. */
  stateDirectory?: string;
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

/** The overlay file a process reads, if it reads one at all.
 *
 * An explicit file wins over the configuration directory: it is how a script or a second checkout
 * points at another set of records without moving the one the interactive client uses.
 * @param options - Resolved options.
 * @returns Absolute path of the overlay to try.
 */
export function loopOverlayFile(options: LoopSourceOptions): string {
  return options.overlayFile ?? join(options.configDirectory, 'loop.yaml');
}

/** Layer one user file over the shipped records.
 *
 * A record is taken whole: replacing one does not merge its fields with the shipped copy, because a
 * record is a single prompt contract and a half-new brief with a half-old round table is a protocol
 * nobody wrote. Records the file does not name are untouched, which is what lets a shipped fix reach
 * an install that customises something else.
 * @param builtin - Shipped records.
 * @param overlay - Parsed user file.
 * @returns The merged table and the names the user file replaced or added.
 */
export function mergeLoopSource(builtin: LoopPromptSource, overlay: LoopOverlaySource):
{ source: LoopPromptSource; overridden: string[]; added: string[] } {
  const overridden: string[] = [];
  const added: string[] = [];
  for (const name of Object.keys(overlay.protocols ?? {})) {
    (Object.hasOwn(builtin.protocols, name) ? overridden : added).push(name);
  }
  return {
    source: {
      version: 1,
      defaults: {
        score: overlay.defaults?.score ?? builtin.defaults.score,
        tries: overlay.defaults?.tries ?? builtin.defaults.tries,
      },
      protocols: { ...builtin.protocols, ...(overlay.protocols ?? {}) },
    },
    overridden,
    added,
  };
}

/** Read the merged records for one process.
 *
 * The shipped file falls back to the compiled-in table with a warning, because a packaging mistake
 * should not stop the client; a user file does not, because an invalid override the operator wrote is
 * a mistake they can fix and a silent fallback would run the shipped records while they believe their
 * own are in force. An absent overlay is ordinary: most installs have none.
 * @param options - Resolution options.
 * @returns The merged records, their sources and the notes to show the operator.
 * @throws when the overlay exists but is not a valid loop file.
 */
export async function loadLoopSource(options: LoopSourceOptions): Promise<LoopSourceLoad> {
  const fallback = options.fallback ?? (LOOP_PROMPTS as unknown as LoopPromptSource);
  const warnings: string[] = [];
  const shipped = await readShipped(options.builtinFile ?? shippedLoopFile(), fallback, warnings);
  const overlayPath = loopOverlayFile(options);
  const raw = await readText(overlayPath);
  if (raw === undefined) {
    return {
      source: shipped.source,
      info: {
        ...(shipped.file === undefined ? {} : { builtin: shipped.file }),
        overridden: [], added: [], warnings,
      },
    };
  }
  const overlay = parseOverlay(overlayPath, raw);
  const merged = mergeLoopSource(shipped.source, overlay);
  const drift = await stampOverrides(options.stateDirectory, shipped.source, merged.overridden, overlayPath);
  return {
    source: merged.source,
    info: {
      ...(shipped.file === undefined ? {} : { builtin: shipped.file }),
      file: overlayPath,
      overridden: merged.overridden,
      added: merged.added,
      warnings: [...warnings, ...drift],
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
Promise<{ source: LoopPromptSource; file?: string }> {
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
  return { source: parsed as LoopPromptSource, file: path };
}

/** Parse one overlay file, refusing anything the renderer would misread.
 * @param path - Overlay file path, used in every message.
 * @param raw - File contents.
 * @returns The parsed overlay.
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

/** Report a shipped record that changed under the operator's override.
 *
 * The stamp is the only durable trace of which shipped copy an override was written against. When a
 * later version ships a different definition of a record this install overrides, that update cannot
 * be applied — the operator's file wins by design — so it is reported once per change instead of
 * being lost silently. The write is best effort: a state directory that cannot be written costs a
 * warning, never a failed start.
 * @param stateDirectory - Directory holding the stamp; omitted disables the check.
 * @param builtin - Shipped records, read before merging.
 * @param overridden - Names the overlay replaced.
 * @param overlayPath - Overlay file the names came from, named in the warning.
 * @returns One warning per shipped record that changed since it was last seen.
 */
async function stampOverrides(stateDirectory: string | undefined, builtin: LoopPromptSource,
  overridden: readonly string[], overlayPath: string): Promise<string[]> {
  if (stateDirectory === undefined) return [];
  const path = join(stateDirectory, 'loop-overrides.json');
  const warnings: string[] = [];
  const current: Record<string, string> = {};
  let previous: Record<string, string> = {};
  const raw = await readText(path);
  // No override and no stamp: an install that never customised a shipped record leaves no file behind.
  if (raw === undefined && overridden.length === 0) return [];
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { records?: Record<string, string> };
      if (parsed.records !== null && typeof parsed.records === 'object') previous = parsed.records;
    } catch { previous = {}; }
  }
  for (const name of overridden) {
    const record = builtin.protocols[name];
    // A name the shipped table does not have is an addition, not an override: there is no upstream
    // definition for it to fall behind.
    if (record === undefined) continue;
    const digest = digestOf(record);
    current[name] = digest;
    if (previous[name] !== undefined && previous[name] !== digest) {
      warnings.push(`Your ${name} in ${overlayPath} replaces a shipped record that changed in this version; `
        + `the shipped update is not applied to your copy.`);
    }
  }
  const stamp = `${JSON.stringify({ version: 1, records: current }, null, 2)}\n`;
  if (stamp !== raw) {
    try { await ensureDirectory(stateDirectory); await writePrivateFile(path, stamp); }
    catch { /* The stamp only enables a warning; failing to write it must not stop the client. */ }
  }
  return warnings;
}

/** Content digest of one record, stable across key order because it hashes the serialized record.
 * @param record - Shipped record.
 * @returns Lowercase hex sha256.
 */
function digestOf(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/** Readable text for anything thrown. */
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
