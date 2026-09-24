/** Typed access to the loop prompts and the placeholder renderer.
 *
 * The loop record is configuration, not code: the shipped `loop.yaml` is read at startup from beside
 * the package and a user file may be layered over it (`loop-source.ts`), then the merged table is
 * installed here once. `loop-prompts-schema.ts` holds the shape and the rules, and
 * `loop-prompts.generated.ts` is the compiled-in fallback for a package whose file is missing. This
 * module turns one record into the strings a protocol needs, so the dynamic parts (this round's title,
 * its checklist, the record's own vars) are filled here and nowhere else. A template may only use
 * placeholders the caller can supply; anything else throws rather than putting a literal `{{name}}`
 * into a prompt.
 */
import { LOOP_PROMPTS } from './loop-prompts.generated.ts';

import type { LoopSourceInfo } from '../contracts.ts';
import type { LoopPromptSource, LoopProtocolText, LoopRoundText } from './loop-prompts-schema.ts';

export type { LoopPromptSource, LoopProtocolText, LoopRoundText } from './loop-prompts-schema.ts';

/** Values one render call supplies; a record's `vars` are merged in on top of these. */
export interface LoopPromptValues {
  from: number;
  to: number;
  score: number;
  tries: number;
  step: number;
  attempt: number;
}

/** The rendering API one record uses. */
export interface LoopPromptText {
  readonly kind: string;
  /** Progress label, already rendered with the record's vars. */
  readonly title: string;
  readonly steps: number;
  readonly artifact?: string;
  /** Rendered line the artifact must contain for one step, when the record declares one. */
  artifactMarker(step: number): string | undefined;
  /** Extra requirements folded on top of every round's rubric, when the record declares them. */
  readonly standard?: string;
  /** This record's fixed inputs as rendered, with any per-run override already applied. */
  readonly vars: Readonly<Record<string, string>>;
  readonly defaultScore: number;
  readonly defaultTries: number;
  /** Which phase a step starts in; absent means the protocol asks for work first. */
  readonly starts?: 'verify' | 'work';
  /** Round label; steps outside the table get the fallback, step 0 the empty string. */
  roundTitle(step: number): string;
  /** That round's checklist; steps past the table reuse the last round's, step 0 has none. */
  checks(step: number): string;
  /** What the forked verifier is told this step is about, when the record names it. */
  focus(step: number): string | undefined;
  /** The opening prompt for one attempt, still missing the result contract the caller appends. */
  brief(values: LoopPromptValues): string[];
  /** The shorter prompt for a later attempt on the same step. */
  followUp(values: LoopPromptValues): string[];
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
/** The records in force: the shipped file with the user's layered on top, installed once at startup
 * and replaced only by another install, never by a reload while a run is in flight. */
let SOURCE = LOOP_PROMPTS as unknown as LoopPromptSource;

/** Every record's rendered prompts and its static inputs. */
export interface LoopPrompts {
  /** Record names in file order, which is the order `/loop` lists them in an error. */
  names: readonly string[];
  /** One record, or undefined when no record has that name.
   *
   * @param kind - Record key.
   * @param overrides - Values that replace the record's own `vars` for this rendering only.
   */
  find(kind: string, overrides?: Readonly<Record<string, string>>): LoopPromptText | undefined;
  /** One record's declared `vars`, unrendered, so a form can offer them before a run starts. */
  vars(kind: string): Readonly<Record<string, string>>;
}

/** Replace every `{{name}}` in one template list.
 * @param lines - Template lines.
 * @param values - Values keyed by placeholder name.
 * @param kind - Record the template came from, for the error message.
 * @returns The rendered lines.
 */
function fill(lines: readonly string[], values: Readonly<Record<string, string | number | undefined>>, kind: string): string[] {
  return lines.map(line => line.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`loop.yaml(${kind}): no value for {{${name}}}`);
    return String(value);
  }));
}

/** Wrap one record in the renderer.
 * @param kind - Record key in loop.yaml, also the loop's `kind`.
 * @param protocol - The record itself.
 * @param overrides - Values that replace the record's own `vars` for this rendering.
 * @returns Its prompt text and renderer.
 */
function render(kind: string, protocol: LoopProtocolText, overrides?: Readonly<Record<string, string>>): LoopPromptText {
  const round = (step: number): LoopRoundText | undefined => (step < 1 ? undefined : protocol.rounds[step - 1]);
  const roundTitle = (step: number): string => {
    if (step < 1) return '';
    return round(step)?.title ?? protocol.fallbackLabel;
  };
  const checks = (step: number): string => {
    if (step < 1) return '';
    return round(step)?.checks ?? protocol.rounds[protocol.rounds.length - 1]?.checks ?? '';
  };
  // A per-run override wins over the record's declared value, so retargeting a record never edits it.
  const vars: Readonly<Record<string, string>> = { ...(protocol.vars ?? {}), ...(overrides ?? {}) };
  // The artifact is a template like the title: a record whose runs target different inputs names one
  // file per input (`{{path}}.review.md`), so a run never reads another input's conclusions.
  const artifact = protocol.artifact === undefined ? undefined : fill([protocol.artifact], { ...vars }, kind)[0]!;
  const values = (runtime: LoopPromptValues): Record<string, string | number | undefined> => ({
    ...vars,
    ...runtime,
    title: roundTitle(runtime.step),
    artifact,
    checks: checks(runtime.step),
  });
  return {
    kind,
    // The title is static per run: it may use vars, never the step.
    title: fill([protocol.title], { ...vars }, kind)[0]!,
    steps: protocol.steps,
    ...(artifact === undefined ? {} : { artifact }),
    ...(protocol.standard === undefined ? {} : { standard: protocol.standard }),
    vars,
    defaultScore: protocol.defaults?.score ?? SOURCE.defaults.score,
    defaultTries: protocol.defaults?.tries ?? SOURCE.defaults.tries,
    ...(protocol.starts === undefined ? {} : { starts: protocol.starts }),
    roundTitle,
    checks,
    artifactMarker: protocol.artifactMarker === undefined ? () => undefined
      : step => fill([protocol.artifactMarker!], { ...vars, step, title: roundTitle(step), artifact }, kind)[0]!,
    focus: step => protocol.verifyFocus === undefined
      ? undefined
      : fill([protocol.verifyFocus], { ...vars, step, title: roundTitle(step) }, kind)[0]!,
    brief: runtime => fill(protocol.brief, values(runtime), kind),
    followUp: runtime => fill(protocol.followUp, values(runtime), kind),
  };
}

/** All records, rendered when the source is installed: a file edited mid-run cannot change a brief. */
let cache: LoopPrompts | undefined;
/** Where the installed records came from, for the record list to show. */
let info: LoopSourceInfo = { overridden: [], added: [], warnings: [] };

/** Put the records this process runs in place, before any run or record list reads them.
 *
 * The files are read and merged at startup rather than at module load, so a bad user file can be
 * reported and refused before the client opens, and a run keeps the rubric it started with even if
 * the file is edited underneath it.
 * @param source - Merged records: shipped ones with the user's file layered on top.
 * @param sourceInfo - Where they came from, and what the user's file changed.
 */
export function installLoopSource(source: LoopPromptSource, sourceInfo: LoopSourceInfo): void {
  SOURCE = source;
  info = { ...sourceInfo, overridden: [...sourceInfo.overridden], added: [...sourceInfo.added], warnings: [...sourceInfo.warnings] };
  cache = undefined;
}

/** Where the installed records came from.
 * @returns The installed source info; the compiled-in records are the empty default.
 */
export function loopSourceInfo(): LoopSourceInfo {
  return info;
}

/** The records in force.
 * @returns Names, lookups and the declared vars of each record, built once per installed source.
 */
export function loopPrompts(): LoopPrompts {
  if (cache !== undefined) return cache;
  const rendered = new Map<string, LoopPromptText>();
  for (const [kind, protocol] of Object.entries(SOURCE.protocols)) rendered.set(kind, render(kind, protocol));
  const source = SOURCE.protocols;
  cache = {
    names: [...rendered.keys()],
    find: (kind, overrides) => {
      const protocol = source[kind];
      if (protocol === undefined) return undefined;
      // The default rendering is cached because the record list reads it on every frame; overrides are
      // rare, so only a run that retargets a record pays for re-rendering.
      return overrides === undefined || Object.keys(overrides).length === 0
        ? rendered.get(kind) : render(kind, protocol, overrides);
    },
    vars: kind => source[kind]?.vars ?? {},
  };
  return cache;
}
