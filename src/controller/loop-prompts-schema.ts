/** The shape of loop.yaml and the rules an editor must not break.
 *
 * Kept apart from `loop-prompts.ts` so the build script can validate a YAML file before the
 * generated module exists: this module imports nothing, while the renderer imports the generated
 * data. The validator is the single copy of the schema — the generator, the runtime loader and the
 * tests all call it, so a file that passes here is the one the renderer will read.
 *
 * Two entry points share one set of rules: `validateLoopPrompts` checks a whole built-in file, and
 * `validateLoopOverlayPrompts` checks a user file that may carry only the records it changes.
 */

/** One round: the label the progress line shows, and the checklist that round is judged against. */
export interface LoopRoundText {
  readonly title: string;
  readonly checks: string;
}

/** One protocol record as it appears in loop.yaml. */
export interface LoopProtocolText {
  /** Progress label; may use the record's own `vars`, e.g. `Designdoc review · {{path}}`. */
  readonly title: string;
  readonly steps: number;
  readonly artifact?: string;
  /** Line the artifact must contain once the round is done; a hard condition no score can override. */
  readonly artifactMarker?: string;
  readonly fallbackLabel: string;
  readonly verifyFocus?: string;
  /** Extra requirements folded on top of every round's rubric; replaces the old `/verify`. */
  readonly standard?: string;
  /** Fixed inputs this record's templates may use (a document path, a target, a threshold…). */
  readonly vars?: Readonly<Record<string, string>>;
  /** Per-record score / tries, overriding the global defaults below. */
  readonly defaults?: { readonly score?: number; readonly tries?: number };
  /** Which phase a step starts in: verifying the existing artifact, or working on it. */
  readonly starts?: 'verify' | 'work';
  readonly rounds: readonly LoopRoundText[];
  readonly brief: readonly string[];
  readonly followUp: readonly string[];
}

/** The whole document; the generated module and every parsed file are cast to this shape. */
export interface LoopPromptSource {
  readonly version: number;
  readonly defaults: { readonly score: number; readonly tries: number };
  readonly protocols: Readonly<Record<string, LoopProtocolText>>;
}

/** A parsed document before validation, where every field is still suspect. */
type LoopDocument = {
  version?: unknown;
  defaults?: unknown;
  protocols?: unknown;
};

/** Placeholders every template may use; a record's own `vars` add to these. */
export const LOOP_PLACEHOLDERS: readonly string[] = ['from', 'to', 'score', 'tries', 'step', 'attempt', 'title', 'artifact', 'checks'];

/** Record names that belong to `/loop` itself, so a protocol cannot shadow a subcommand. */
export const RESERVED_PROTOCOL_NAMES: readonly string[] = ['answer', 'abort', 'stop'];

/** Check one parsed document against the schema the renderer relies on.
 *
 * Every message names the field at fault, because the only reader is a maintainer editing YAML.
 * @param source - Parsed loop.yaml, or anything else that claims to be one.
 * @returns One message per problem; an empty list means valid.
 */
export function validateLoopPrompts(source: unknown): string[] {
  const errors: string[] = [];
  const document = asDocument(source);
  if (document.version !== 1) errors.push('version must be 1');
  validateDefaults(document.defaults, errors, true);
  const protocols = document.protocols;
  if (protocols === null || typeof protocols !== 'object' || Array.isArray(protocols) || Object.keys(protocols ?? {}).length === 0) {
    errors.push('protocols must be a non-empty mapping');
    return errors;
  }
  validateProtocols(protocols as Record<string, LoopProtocol>, errors);
  return errors;
}

/** Check an existing runtime file before merging shipped records into it.
 *
 * Older user files may be partial: one record or one changed default is valid, so a missing or empty
 * `protocols` is accepted here. Every declared record follows the shipped record rules.
 * @param source - Parsed overlay file.
 * @returns One message per problem; an empty list means valid.
 */
export function validateLoopOverlayPrompts(source: unknown): string[] {
  const errors: string[] = [];
  const document = asDocument(source);
  // A version is required even from an overlay: a file written for a later shape must fail loudly
  // instead of having its fields read as this shape's, which is how a silent misread becomes a run
  // judged against a rubric nobody wrote.
  if (document.version !== 1) errors.push('version must be 1');
  validateDefaults(document.defaults, errors, false);
  const protocols = document.protocols;
  if (protocols === undefined || protocols === null) return errors;
  if (typeof protocols !== 'object' || Array.isArray(protocols)) {
    errors.push('protocols must be a mapping');
    return errors;
  }
  validateProtocols(protocols as Record<string, LoopProtocol>, errors);
  return errors;
}

/** A parsed document with every unsafe value normalized to `undefined`.
 * @param source - Anything a caller parsed out of a file.
 * @returns The document, or an empty one for a null, scalar or array root.
 */
function asDocument(source: unknown): LoopDocument {
  return source !== null && typeof source === 'object' && !Array.isArray(source) ? source as LoopDocument : {};
}

/** One record as the validator reads it: every field present but unchecked. */
type LoopProtocol = Partial<LoopProtocolText> & { rounds?: readonly { title?: unknown; checks?: unknown }[] };

/** Check the global defaults.
 *
 * A shipped file must state them, because every record falls back to them. An overlay may state
 * neither, one or both, but a value it does state reaches real runs, so it is checked for range
 * even though the shipped file only has to be numeric.
 * @param defaults - The `defaults` field as parsed.
 * @param errors - Collector to append messages to.
 * @param required - Whether this document must carry both numbers.
 */
function validateDefaults(defaults: unknown, errors: string[], required: boolean): void {
  if (defaults === undefined || defaults === null) {
    if (required) {
      errors.push('defaults.score must be a number');
      errors.push('defaults.tries must be a number');
    }
    return;
  }
  if (typeof defaults !== 'object' || Array.isArray(defaults)) {
    errors.push('defaults must be a mapping');
    return;
  }
  const { score, tries } = defaults as { score?: unknown; tries?: unknown };
  if (required) {
    if (!Number.isFinite(score)) errors.push('defaults.score must be a number');
    if (!Number.isFinite(tries)) errors.push('defaults.tries must be a number');
    return;
  }
  if (score !== undefined && (!Number.isFinite(score) || (score as number) < 0 || (score as number) > 10)) {
    errors.push('defaults.score must be a number in 0-10');
  }
  if (tries !== undefined && (!Number.isInteger(tries) || (tries as number) < 1)) {
    errors.push('defaults.tries must be a positive integer');
  }
}

/** Check every record of one document against the rules the renderer relies on.
 * @param protocols - The `protocols` mapping.
 * @param errors - Collector to append messages to.
 */
function validateProtocols(protocols: Record<string, LoopProtocol>, errors: string[]): void {
  const runtime = new Set(LOOP_PLACEHOLDERS);
  const reserved = new Set(RESERVED_PROTOCOL_NAMES);
  const placeholders = (text: string): string[] => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]!);
  for (const [kind, protocol] of Object.entries(protocols)) {
    const at = `protocols.${kind}`;
    if (reserved.has(kind)) errors.push(`${at} is a reserved name: ${RESERVED_PROTOCOL_NAMES.join(', ')} belong to /loop itself`);
    // A template may name a runtime value or one of this record's own vars, and nothing else.
    const vars = protocol?.vars;
    if (vars !== undefined && (vars === null || typeof vars !== 'object' || Array.isArray(vars))) {
      errors.push(`${at}.vars must be a mapping of names to strings`);
    }
    const varNames = new Set(vars !== undefined && typeof vars === 'object' && !Array.isArray(vars) ? Object.keys(vars) : []);
    if (vars !== undefined && typeof vars === 'object' && !Array.isArray(vars)) {
      for (const [name, value] of Object.entries(vars)) {
        if (typeof value !== 'string') errors.push(`${at}.vars.${name} must be a string`);
        if (runtime.has(name)) errors.push(`${at}.vars.${name} shadows a runtime placeholder`);
      }
    }
    const allowed = new Set([...runtime, ...varNames]);
    const checkPlaceholders = (text: string, where: string): void => {
      for (const name of placeholders(text)) if (!allowed.has(name)) errors.push(`${where}: unknown placeholder {{${name}}}`);
    };
    checkPlaceholders(typeof protocol?.title === 'string' ? protocol.title : '', `${at}.title`);
    if (typeof protocol?.title !== 'string' || protocol.title === '') errors.push(`${at}.title must be a non-empty string`);
    if (!Number.isInteger(protocol?.steps) || (protocol?.steps ?? 0) < 1) errors.push(`${at}.steps must be a positive integer`);
    if (protocol?.artifact !== undefined && (typeof protocol.artifact !== 'string' || protocol.artifact === '')) {
      errors.push(`${at}.artifact must be a non-empty string when present`);
    } else if (typeof protocol?.artifact === 'string') {
      // The file name may use the record's vars — that is how one run per input gets its own file —
      // but never a runtime placeholder: the artifact must not move between rounds.
      for (const name of placeholders(protocol.artifact)) {
        if (!allowed.has(name) || runtime.has(name)) {
          errors.push(`${at}.artifact: {{${name}}} must be a record var; the artifact may not depend on the round`);
        }
      }
    }
    if (protocol?.artifactMarker !== undefined) {
      if (typeof protocol.artifactMarker !== 'string' || protocol.artifactMarker.trim() === '') {
        errors.push(`${at}.artifactMarker must be a non-empty string when present`);
      } else {
        checkPlaceholders(protocol.artifactMarker, `${at}.artifactMarker`);
      }
      // A marker without a file to look in cannot be checked, so the pair is required together.
      if (typeof protocol.artifact !== 'string' || protocol.artifact === '') {
        errors.push(`${at}.artifactMarker needs ${at}.artifact: there is no file to look in`);
      }
    }
    if (typeof protocol?.fallbackLabel !== 'string' || protocol.fallbackLabel === '') errors.push(`${at}.fallbackLabel must be a non-empty string`);
    if (protocol?.standard !== undefined && (typeof protocol.standard !== 'string' || protocol.standard.trim() === '')) {
      errors.push(`${at}.standard must be a non-empty string when present`);
    }
    if (protocol?.starts !== undefined && protocol.starts !== 'verify' && protocol.starts !== 'work') {
      errors.push(`${at}.starts must be 'verify' or 'work'`);
    }
    if (protocol?.defaults !== undefined) {
      const { score, tries } = protocol.defaults;
      if (score !== undefined && (!Number.isFinite(score) || score < 0 || score > 10)) errors.push(`${at}.defaults.score must be a number in 0-10`);
      if (tries !== undefined && (!Number.isInteger(tries) || tries < 1)) errors.push(`${at}.defaults.tries must be a positive integer`);
    }
    const rounds = protocol?.rounds;
    if (!Array.isArray(rounds)) {
      errors.push(`${at}.rounds must be a list`);
    } else {
      if (rounds.length > 0 && rounds.length !== protocol?.steps) {
        errors.push(`${at}.rounds has ${rounds.length} entries but steps is ${protocol?.steps}`);
      }
      rounds.forEach((round, index) => {
        if (typeof round?.title !== 'string' || round.title === '') errors.push(`${at}.rounds[${index}].title must be a non-empty string`);
        if (typeof round?.checks !== 'string' || round.checks === '') errors.push(`${at}.rounds[${index}].checks must be a non-empty string`);
      });
    }
    for (const key of ['brief', 'followUp'] as const) {
      const lines = protocol?.[key];
      if (!Array.isArray(lines) || lines.length === 0) { errors.push(`${at}.${key} must be a non-empty list`); continue; }
      lines.forEach((line, index) => {
        if (typeof line !== 'string') { errors.push(`${at}.${key}[${index}] must be a string`); return; }
        checkPlaceholders(line, `${at}.${key}[${index}]`);
      });
    }
    const checksLines = (protocol?.brief ?? []).filter(line => typeof line === 'string' && line.trim() === '{{checks}}');
    if ((rounds?.length ?? 0) > 0 && checksLines.length !== 1) errors.push(`${at}.brief must contain exactly one line that is just {{checks}}`);
    if ((rounds?.length ?? 0) === 0 && checksLines.length > 0) errors.push(`${at}.brief uses {{checks}} but defines no rounds`);
    if (protocol?.verifyFocus !== undefined) {
      if (typeof protocol.verifyFocus !== 'string' || protocol.verifyFocus === '') errors.push(`${at}.verifyFocus must be a non-empty string when present`);
      else checkPlaceholders(protocol.verifyFocus, `${at}.verifyFocus`);
    }
  }
}
