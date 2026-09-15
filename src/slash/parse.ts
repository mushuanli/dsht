/** Slash-command syntax: one composer line in, one semantic command out.
 *
 * This module is a pure leaf. It reads no UI facts, performs no effects and imports nothing from the
 * application, so "what the line means" stays separate from "what Enter currently does" (which is
 * `ui/routing.ts`) and from "may this run now" (which is the application's dispatch).
 */
import { commandMatches, resolveCommand } from './registry.ts';

/** One parsed command; every side effect stays with the caller. */
export type Command =
  | { kind: 'ignore' }
  | { kind: 'copy' }
  | { kind: 'quit' }
  | { kind: 'panel'; panel: 'cost' | 'status' | 'help' }
  | { kind: 'remove'; target: 'workspace' | 'session'; query: string }
  | { kind: 'navigate'; target: 'workspace' | 'session'; query?: string }
  | { kind: 'latest' }
  | { kind: 'models'; args: string[] }
  | { kind: 'queue' }
  | { kind: 'newSession' }
  /** Open the saved-prompt picker, or save the following text as a shortcut prompt. */
  | { kind: 'prompts' }
  | { kind: 'savePrompt'; text: string }
  | { kind: 'history'; query: string }
  | { kind: 'sessionSearch'; command: '/ssearch' | '/wsearch'; query: string }
  | { kind: 'historySearch'; query: string }
  | { kind: 'think'; target: string }
  | { kind: 'older' }
  | { kind: 'compact' }
  /** Clear the client's own HANDOFF.md, then ask the agent to write a fresh session handoff. */
  | { kind: 'handoff' }
  /** Start the client-driven scored design review. */
  | { kind: 'designReview'; options: LoopOptions }
  /** Wrap one free-form prompt in the scored loop; see `LoopOptions`. */
  | { kind: 'loop'; options: LoopOptions; prompt: string }
  | { kind: 'cancel' }
  | { kind: 'approval'; allowed: boolean }
  | { kind: 'hostCommand'; line: string }
  /** A local `!` command, run on this machine rather than the host. */
  | { kind: 'shell'; command: string }
  | { kind: 'export'; destination?: string }
  | { kind: 'exportHtml'; destination?: string }
  | { kind: 'coredump'; tag?: string }
  | { kind: 'error'; message: string }
  | { kind: 'prompt'; text: string };

/** Options carried by the scored-loop commands (`/design-review` and its siblings).
 *
 * Only the fields the operator actually typed are present, so the syntax layer validates each value
 * it sees and the application owns the defaults and the cross-field rules (`to >= from`).
 */
export interface LoopOptions {
  /** First step to run; default 1. */
  from?: number;
  /** Last step to run; default the protocol's last step. */
  to?: number;
  /** Passing score per step, 0-10 and possibly fractional; default 8. */
  score?: number;
  /** Attempts allowed per step; default 10. */
  tries?: number;
}

/** How each loop flag names an option and validates its value. */
const LOOP_FLAGS: Readonly<Record<string, { key: keyof LoopOptions; valid: (value: number) => boolean }>> = {
  '--from': { key: 'from', valid: value => Number.isSafeInteger(value) && value >= 1 },
  '--to': { key: 'to', valid: value => Number.isSafeInteger(value) && value >= 1 },
  '--score': { key: 'score', valid: value => Number.isFinite(value) && value >= 0 && value <= 10 },
  '--tries': { key: 'tries', valid: value => Number.isSafeInteger(value) && value >= 1 },
};

/** The one message every malformed `/design-review` line receives. */
export const DESIGN_REVIEW_USAGE = 'Use /design-review [--from N] [--to N] [--score X] [--tries N]';

/** Parse the shared `--from/--to/--score/--tries` flags, shared by every scored-loop command.
 * @param rest - Text after the command name.
 * @returns The options, or undefined when any flag or value is malformed.
 */
export function parseLoopOptions(rest: string): LoopOptions | undefined {
  const options: LoopOptions = {};
  const words = rest.trim().split(/\s+/).filter(Boolean);
  for (let index = 0; index < words.length; index += 2) {
    const flag = words[index]!;
    const raw = words[index + 1];
    const spec = LOOP_FLAGS[flag];
    if (spec === undefined || raw === undefined) return undefined;
    const number = Number(raw);
    if (!spec.valid(number)) return undefined;
    options[spec.key] = number;
  }
  return options;
}

/** Parse `/design-review` and its flags, rejecting anything malformed.
 * @param value - Trimmed line that starts with `/design-review`.
 * @returns The command, or the usage error.
 */
function designReviewCommand(value: string): Command {
  const options = parseLoopOptions(value.slice('/design-review'.length));
  return options === undefined ? { kind: 'error', message: DESIGN_REVIEW_USAGE } : { kind: 'designReview', options };
}

/** The one message every malformed `/loop` line receives. */
export const LOOP_USAGE = 'Use /loop [--from N] [--to N] <score> <tries> <prompt>';

/** Largest attempt budget one `/loop` step may declare, so an ad-hoc loop stays bounded. */
const LOOP_TRIES_MAX = 10;

/** Largest last step one `/loop` may declare, for the same reason. */
const LOOP_STEPS_MAX = 10;

/** Parse `/loop <score> <tries> <prompt>`, with an optional leading step range.
 *
 * The prompt is free text, so only its two leading tokens are numbers; everything after them is
 * handed to the loop verbatim, line breaks included.
 * @param value - Trimmed line that starts with `/loop`.
 * @returns The command, or the usage error.
 */
function loopCommand(value: string): Command {
  let rest = value.slice('/loop'.length).replace(/^\s+/, '');
  const options: LoopOptions = {};
  // Optional step range first, so the two positional numbers and the prompt stay unambiguous.
  for (;;) {
    const flag = /^(--from|--to)\s+(\S+)\s*/.exec(rest);
    if (!flag) break;
    const name = flag[1]!;
    const number = Number(flag[2]);
    const valid = name === '--from'
      ? LOOP_FLAGS['--from']!.valid(number)
      : LOOP_FLAGS['--to']!.valid(number) && number <= LOOP_STEPS_MAX;
    if (!valid) return { kind: 'error', message: LOOP_USAGE };
    if (name === '--from') options.from = number; else options.to = number;
    rest = rest.slice(flag[0].length);
  }
  const pair = /^(\S+)\s+(\S+)\s*/.exec(rest);
  if (!pair) return { kind: 'error', message: LOOP_USAGE };
  const score = Number(pair[1]);
  const tries = Number(pair[2]);
  if (!LOOP_FLAGS['--score']!.valid(score)) return { kind: 'error', message: LOOP_USAGE };
  if (!Number.isSafeInteger(tries) || tries < 1 || tries > LOOP_TRIES_MAX) return { kind: 'error', message: LOOP_USAGE };
  const prompt = rest.slice(pair[0].length).trim();
  if (!prompt) return { kind: 'error', message: LOOP_USAGE };
  return { kind: 'loop', options: { ...options, score, tries }, prompt };
}

/** Parse workspace and resume navigation, including their long aliases. */
function navigationCommand(value: string): { kind: 'workspace' | 'session'; query?: string } | undefined {
  const match = /^\/(ws|workspace|workspaces|resume|session|sessions)(?:\s+(.+))?$/.exec(value);
  if (!match) return undefined;
  return { kind: match[1] === 'ws' || match[1]!.startsWith('workspace') ? 'workspace' : 'session', query: match[2] };
}

/** Strip one pair of surrounding quotes from an argument. */
function unquote(value: string): string { return value.replace(/^(["'])(.*)\1$/, '$2'); }

/** Parse one composer line into a command without performing any of its effects.
 *
 * The order of the checks is the command precedence: the in-place panels, navigation and removal,
 * then the session and host commands, then a plain prompt. Facts about the current screen or a
 * pending interaction are deliberately absent: they decide whether a command may run, not what it is.
 *
 * A leading token that names exactly one command is resolved first, so `/pro Add tests` runs
 * `/prompt Add tests`; an ambiguous token is left alone and reported with its candidates.
 * @param line - Draft exactly as submitted.
 * @returns The parsed command.
 */
export function parseCommand(line: string): Command {
  const raw = line.trim();
  if (!raw) return { kind: 'ignore' };
  const value = resolveToken(raw);
  // `!` runs on the machine this client is on; it never reaches the host or the model.
  if (value.startsWith('!')) {
    const command = value.slice(1).trim();
    return command ? { kind: 'shell', command } : { kind: 'error', message: 'Type a command after !' };
  }
  if (value === '/copy') return { kind: 'copy' };
  if (value === '/quit') return { kind: 'quit' };
  if (value === '/cost') return { kind: 'panel', panel: 'cost' };
  if (value === '/status') return { kind: 'panel', panel: 'status' };
  if (value === '/help') return { kind: 'panel', panel: 'help' };
  const navigation = navigationCommand(value);
  if (navigation && /^--(?:delete|archive)(?:\s|$)/.test(navigation.query ?? '')) {
    const query = navigation.query!.replace(/^--(?:delete|archive)\s*/, '');
    if (!query) return { kind: 'error', message: 'Specify the name or ID to remove' };
    return { kind: 'remove', target: navigation.kind, query };
  }
  if (navigation) return { kind: 'navigate', target: navigation.kind, query: navigation.query };
  if (value === '/latest') return { kind: 'latest' };
  if (/^\/model(?: |$)/.test(value)) {
    const args = value.split(/\s+/).slice(1);
    if (args.length && (args.length < 2 || args.length > 3)) return { kind: 'error', message: 'Use /model [provider model [effort]]' };
    return { kind: 'models', args };
  }
  if (value === '/queue') return { kind: 'queue' };
  if (value === '/new') return { kind: 'newSession' };
  // `/prompt` alone opens the list; any trailing text is the shortcut being saved. Quoting is
  // deliberately not stripped here: the saved prompt is stored exactly as it will be sent.
  if (/^\/prompt(?:\s|$)/.test(value)) {
    const text = value.slice(7).trim();
    return text ? { kind: 'savePrompt', text } : { kind: 'prompts' };
  }
  if (value === '/history' || value.startsWith('/history ')) return { kind: 'history', query: value.slice(8).trim() };
  if (/^\/(?:search|ssearch|wsearch)(?: |$)/.test(value)) {
    const [command, ...words] = value.split(' ');
    const query = words.join(' ').trim();
    if (!query) return { kind: 'error', message: `Use ${command} <text>` };
    return command === '/search' ? { kind: 'historySearch', query }
      : { kind: 'sessionSearch', command: command as '/ssearch' | '/wsearch', query };
  }
  if (/^\/think(?: |$)/.test(value)) return { kind: 'think', target: value.slice(6).trim() };
  if (value === '/older') return { kind: 'older' };
  if (/^\/compact(?: |$)/.test(value)) {
    if (value !== '/compact') return { kind: 'error', message: 'Use /compact (no arguments)' };
    return { kind: 'compact' };
  }
  if (/^\/handoff(?: |$)/.test(value)) {
    if (value !== '/handoff') return { kind: 'error', message: 'Use /handoff (no arguments)' };
    return { kind: 'handoff' };
  }
  if (/^\/design-review(?: |$)/.test(value)) return designReviewCommand(value);
  if (/^\/loop(?: |$)/.test(value)) return loopCommand(value);
  if (value === '/cancel') return { kind: 'cancel' };
  if (value === '/allow') return { kind: 'approval', allowed: true };
  if (value === '/deny') return { kind: 'approval', allowed: false };
  if (/^\/(?:plan|goal|permission|feedback)(?:\s|$)/.test(value)) return { kind: 'hostCommand', line: value };
  if (/^\/export(?:\s|$)/.test(value)) {
    const destination = unquote(value.slice(7).trim());
    return { kind: 'export', ...(destination ? { destination } : {}) };
  }
  if (/^\/export-html(?:\s|$)/.test(value)) {
    const destination = unquote(value.slice(12).trim());
    return { kind: 'exportHtml', ...(destination ? { destination } : {}) };
  }
  if (/^\/coredump(?:\s|$)/.test(value)) {
    // A diagnostic of this client's own heap needs neither a session nor a connected host.
    const tag = unquote(value.slice(9).trim());
    return { kind: 'coredump', ...(tag ? { tag } : {}) };
  }
  if (value.startsWith('/')) return unresolved(value);
  return { kind: 'prompt', text: value };
}

/** First word of a trimmed draft, so arguments are never part of a command name. */
function commandToken(value: string): string {
  const space = value.search(/\s/);
  return space === -1 ? value : value.slice(0, space);
}

/** Resolve a uniquely-named command prefix to the command itself, keeping the arguments.
 * @param value - Trimmed draft.
 * @returns The draft with its command token resolved when it names exactly one command.
 */
function resolveToken(value: string): string {
  if (!value.startsWith('/')) return value;
  const token = commandToken(value);
  const resolved = resolveCommand(token);
  return resolved === undefined || resolved === token ? value : resolved + value.slice(token.length);
}

/** Report a leading token that names no single command, naming what it could mean.
 * @param value - Trimmed draft that starts with `/`.
 * @returns The error command.
 */
function unresolved(value: string): Command {
  const matches = commandMatches(commandToken(value));
  // Exactly one match here is an `exactOnly` command that refused prefix resolution.
  if (matches.length === 1) return { kind: 'error', message: `Type the full command: ${matches[0]}` };
  // A short candidate list helps more than a generic message; a bare `/` matches every command.
  if (matches.length > 1 && matches.length <= 6) return { kind: 'error', message: `Ambiguous command. Matches: ${matches.join(' ')}` };
  return { kind: 'error', message: 'Unknown command. Use /help.' };
}
