/** The pipeline one submitted line travels: interpret → normalize → authorize.
 *
 * Parsing, completion and policy live here; effects never do. The three stages answer three different
 * questions and must not be merged:
 *
 * * `interpret` reads **front-end facts only** (an open menu, copy mode, the path screen) and turns the
 *   raw draft into a `Submission`. It is the last place a UI concept exists;
 * * `normalize` reads **application facts** (is a question waiting?) and turns a submission into the
 *   one `LineCommand` the application can execute. Both front ends share it;
 * * `authorize` reads the command's own declared policy plus application facts and returns a verdict.
 *
 * This module is a pure leaf like the rest of `slash/`: it imports no application, feature or UI code,
 * so every stage can be tested without mounting anything.
 */
import { parseCommand, type Command } from './parse.ts';
import { COMMAND_POLICY, resolveCommand, type CommandPolicy } from './registry.ts';

/** A front-end action: a mode of the composer, never an application effect. */
export type UiAction =
  | { kind: 'ignore' }
  | { kind: 'reference' };

/** A line the application can execute.
 *
 * `Command` is what the syntax layer produces; the two extra kinds are lines the front end only reads
 * while it has context the syntax cannot see — a free-text answer to a waiting question, and a
 * directory typed on the path screen. They travel the same `runCommand` path as every command so the
 * application keeps one dispatch.
 */
export type LineCommand =
  | Command
  | { kind: 'answer'; text: string }
  | { kind: 'path'; value: string };

/** What the front end made of one draft, before any application semantics. */
export type Submission =
  | { kind: 'mode'; action: UiAction }
  | { kind: 'line'; line: string }
  | { kind: 'path'; value: string };

/** A submission that still needs normalizing: a front-end mode is handled by the front end itself. */
export type ExecutableSubmission = Extract<Submission, { kind: 'line' | 'path' }>;

/** Front-end facts `interpret` may read; nothing else is needed. */
export interface InterpretFacts {
  /** The draft exactly as submitted. */
  line: string;
  /** The `@` completion menu owns the draft while open. */
  referenceOpen: boolean;
  /** Copy mode freezes the display and ignores submissions. */
  copyMode: boolean;
  /** The screen the draft was typed on. The only UI concept the pipeline may touch. */
  screen: 'workspaces' | 'sessions' | 'chat' | 'path';
}

/** Decide what the front end has, without any application semantics.
 *
 * On the path screen an absolute directory starts with `/`, which is also how a command starts, so the
 * screen cannot simply claim every line: a line that names a known command (or a `!` shell line) still
 * escapes the screen and is normalized as usual. Everything else there is the directory that was asked
 * for. Without this rule `/srv/data` would be parsed as a command and refused as unknown.
 * @param facts - Current front-end facts.
 * @returns The submission the application will normalize.
 */
export function interpret(facts: InterpretFacts): Submission {
  if (facts.referenceOpen) return { kind: 'mode', action: { kind: 'reference' } };
  if (facts.copyMode) return { kind: 'mode', action: { kind: 'ignore' } };
  const value = facts.line.trim();
  if (!value) return { kind: 'mode', action: { kind: 'ignore' } };
  if (facts.screen === 'path' && !namesCommand(value)) return { kind: 'path', value };
  return { kind: 'line', line: facts.line };
}

/** Whether a line is meant as a command rather than as the directory the path screen asked for.
 * @param value - Trimmed draft.
 * @returns True for a `!` line or a line whose token names exactly one command.
 */
function namesCommand(value: string): boolean {
  if (value.startsWith('!')) return true;
  const token = value.split(/\s+/)[0] ?? '';
  return token.startsWith('/') && resolveCommand(token) !== undefined;
}

/** Application facts `normalize` needs to classify free text. */
export interface NormalizeFacts {
  /** A conversation is selected, so free text has somewhere to go. */
  sessionSelected: boolean;
  /** A question of the selected session is waiting, so free text answers it. */
  question: boolean;
  /** An approval of the selected session is waiting, so free text is not accepted. */
  pending: boolean;
}

/** Turn a submission into the one line the application can execute.
 *
 * The order is the precedence: a directory the screen asked for, then a `/` or `!` line, then the two
 * meanings free text can have while an interaction waits, then a plain message.
 * @param submission - What the front end made of the draft.
 * @param facts - Current application facts.
 * @returns The executable line.
 */
export function normalize(submission: ExecutableSubmission, facts: NormalizeFacts): LineCommand {
  if (submission.kind === 'path') return { kind: 'path', value: submission.value };
  const value = submission.line.trim();
  if (value.startsWith('/') || value.startsWith('!')) return parseCommand(value);
  // A question takes free text as its answer; an approval keeps every choice explicit.
  if (facts.question) return { kind: 'answer', text: value };
  if (facts.pending) return { kind: 'error', message: 'Answer the approval with /allow or /deny' };
  // Free text without a conversation has nowhere to go; saying so beats sending it to no session.
  if (!facts.sessionSelected) return { kind: 'error', message: 'Choose a session or type /ws or /resume' };
  return { kind: 'prompt', text: value };
}

/** Application facts `authorize` needs; all of them exist with or without a UI. */
export interface AuthorizeFacts {
  /** A conversation is selected, so a command that needs one may run. */
  sessionSelected: boolean;
  /** An interaction of that conversation is waiting. */
  pending: boolean;
  /** Whether the selected conversation has a turn or a loop in flight.
   *
   * A loop is reported as `loop` rather than as the turn it runs, because stopping the loop is what
   * the operator has to do first, and that is the reason the refusal has to name.
   */
  during: 'idle' | 'turn' | 'loop';
}

/** Whether one command may run now, and what to execute instead when it may not. */
/** The refusal a front end reports is always the error line, never an arbitrary command. */
export type Verdict =
  | { allow: true; command: LineCommand }
  | { allow: false; error: Extract<Command, { kind: 'error' }> };

/** Apply one command's declared policy to the current application facts.
 *
 * The policy is data on the command kind, so this function never enumerates commands. A kind with no
 * entry has no constraint. The constraint names describe the fact, not the screen: `requiresSession`
 * is refused in headless too (where a session always exists, so the check simply passes), and
 * `requiresNoInteraction` is refused wherever an interaction waits, because a front end without an
 * answer channel cannot satisfy it either.
 * @param command - Line about to be executed.
 * @param facts - Current application facts.
 * @returns The verdict; on refusal, the error command the application should report.
 */
export function authorize(command: LineCommand, facts: AuthorizeFacts): Verdict {
  // `answer` and `path` are lines, not catalog kinds, so the table lookup is by kind string.
  const policy = (COMMAND_POLICY as Readonly<Record<string, CommandPolicy | undefined>>)[command.kind];
  if (policy?.requiresSession === true && !facts.sessionSelected) {
    return { allow: false, error: { kind: 'error', message: 'Select a session first' } };
  }
  if (policy?.requiresNoInteraction === true && facts.pending) {
    return { allow: false, error: { kind: 'error', message: 'Answer the pending question or approval first' } };
  }
  // `during` is checked last: "answer what is waiting" is a more actionable reason than "something is
  // running", and a pending interaction usually means a turn is running too.
  const during = facts.during === 'loop' ? policy?.duringLoop : facts.during === 'turn' ? policy?.duringTurn : undefined;
  if (during === 'deny') {
    return { allow: false, error: { kind: 'error',
      message: facts.during === 'loop' ? 'Stop the running loop first' : 'Wait for the running turn to finish' } };
  }
  return { allow: true, command };
}
