/** Turn one loop.yaml record into the protocol the scored loop runs.
 *
 * The record is the whole protocol: title, steps, rubric, brief, follow-up, artifact and the extra
 * standard. This module only wires that data to the mechanical contract in `loop-contract.ts`, so a
 * new review protocol is a YAML edit — not a new TypeScript file — and `/loop <name>` can run any
 * record without code knowing which one it is.
 */
import { LOOP_MARKER, followUpContract, resultContract, verdictBrief } from './loop-contract.ts';
import { loopPrompts, loopSourceInfo } from './loop-prompts.ts';
import { coversWholeProtocol, type LoopLimits, type LoopProtocol, type PriorVerdict, type VerifyTarget } from './loop.ts';
import type { LoopRecord } from '../contracts.ts';

/** Names `/loop` may run, in file order. */
export function loopProtocolNames(): string[] {
  return [...loopPrompts().names];
}

/** Every record `/loop` may run, in file order, with the defaults a run would start from.
 *
 * The list and the run read the same records, so a chooser can show exactly the name, round count,
 * artifact and defaults the runner would use — never a second table that could drift. A record the
 * user's own file supplied is marked, because an operator who overrode a shipped record can no longer
 * tell the two apart from the name alone.
 * @returns One summary per record.
 */
export function loopRecords(): LoopRecord[] {
  const { overridden, added } = loopSourceInfo();
  const mine = new Set([...overridden, ...added]);
  return loopPrompts().names.flatMap(name => {
    const text = loopPrompts().find(name);
    if (text === undefined) return [];
    return [{ name, title: text.title, steps: text.steps,
      ...(text.artifact === undefined ? {} : { artifact: text.artifact }),
      defaultScore: text.defaultScore, defaultTries: text.defaultTries,
      vars: loopPrompts().vars(name),
      ...(mine.has(name) ? { fromFile: true as const } : {}) }];
  });
}

/** One record's declared variables, so a caller can offer or validate them before a run starts.
 * @param name - Record key in loop.yaml.
 * @returns The record's `vars`, or undefined when no record has that name.
 */
export function loopRecordVars(name: string): Readonly<Record<string, string>> | undefined {
  return loopPrompts().find(name) === undefined ? undefined : loopPrompts().vars(name);
}

/** Rubric the verifier scores against: the round's own checklist plus the record's standard.
 *
 * The standard is part of the record, so it travels with the run instead of living in session
 * state; a record without one scores on its checklist alone.
 * @param checks - This round's checklist.
 * @param standard - The record's extra requirements, when it declares any.
 * @returns The rubric text.
 */
export function roundStandard(checks: string, standard?: string): string {
  return standard === undefined ? checks : `${checks}\n\n附加要求（记录自带）：\n${standard}`;
}

/** Build one record, or undefined when no record has that name.
 *
 * The record's data is read once here, so a run keeps the rubric, standard and vars it started
 * with even if `loop.yaml` is edited (or reloaded) while it is in flight.
 * @param name - Record key in loop.yaml.
 * @param forked - Delegate each round's verdict to an independent verifier process.
 * @param vars - Values that replace the record's own `vars` for this run, e.g. another document.
 * @param selfScoring - Whether this client's own reply may decide an attempt. Without a forked
 *   verifier it always does; with one, only when the operator allowed the verifier's fallback to it.
 *   When it does not, the brief stops asking for a verdict block: nothing reads it, and a visible
 *   score that moves nothing is exactly what a reader mistakes for the real one.
 * @returns The protocol the scored loop runs, or undefined for an unknown name.
 */
export function loopProtocolFor(name: string, forked = false, vars?: Readonly<Record<string, string>>,
  selfScoring = !forked): LoopProtocol | undefined {
  const text = loopPrompts().find(name, vars);
  if (text === undefined) return undefined;
  const standard = (step: number): string => roundStandard(text.checks(step), text.standard);
  const artifact = text.artifact;
  // A run over the whole record ends on its consolidation round, and that round is the only place
  // where "passed" may mean the whole artifact: the verifier is handed every earlier round to
  // re-check, so a later round that broke an earlier requirement cannot pass unnoticed.
  const consolidates = (limits: LoopLimits, step: number): boolean =>
    coversWholeProtocol(limits.from, limits.to, text.steps) && step === text.steps;
  const coverage = (step: number): { title: string; checks: string }[] =>
    Array.from({ length: Math.max(0, step - 1) },
      (_, index) => ({ title: `第 ${index + 1} 轮 · ${text.roundTitle(index + 1)}`, checks: text.checks(index + 1) }));
  return {
    marker: LOOP_MARKER,
    kind: name,
    title: text.title,
    steps: text.steps,
    ...(artifact === undefined ? {} : { artifact }),
    defaultScore: text.defaultScore,
    defaultTries: text.defaultTries,
    ...(text.starts === undefined ? {} : { starts: text.starts }),
    stepLabel: step => text.roundTitle(step),
    artifactMarker: step => text.artifactMarker(step),
    brief: (limits, step, attempt) => [
      ...text.brief({ ...limits, step, attempt }),
      '',
      ...resultContract(name, limits, step, attempt, {
        standard: standard(step),
        ...(artifact === undefined ? {} : { artifact }),
        ...(text.focus(step) === undefined ? {} : { focus: text.focus(step) }),
        ...(consolidates(limits, step) ? { final: true } : {}),
      }, forked ? 'forked' : 'subagent', selfScoring),
    ].join('\n'),
    // The verifier's only input is this prompt and the artifact, so the run's own variables travel
    // with it: without `path` it cannot tell which document this run reviews and can only follow the
    // artifact left by an earlier run against a different one.
    ...(forked ? { verify: (limits: LoopLimits, step: number, attempt: number, target: VerifyTarget, previous?: PriorVerdict) => {
      // The verifier is told the same heading the client will check, so "which section is this round's"
      // is one fact on both sides instead of two readings of the same file.
      const marker = text.artifactMarker(step);
      return verdictBrief({
        ...target, kind: name, step, attempt, previous, standard: standard(step), vars: text.vars,
        ...(artifact === undefined ? {} : { artifact }),
        ...(marker === undefined ? {} : { marker }),
        ...(text.focus(step) === undefined ? {} : { focus: text.focus(step) }),
        ...(consolidates(limits, step) ? { coverage: coverage(step) } : {}),
      });
    } } : {}),
    followUp: (limits, step, attempt) => [
      ...text.followUp({ ...limits, step, attempt }),
      followUpContract(name, step, attempt, selfScoring),
    ].join('\n'),
  };
}
