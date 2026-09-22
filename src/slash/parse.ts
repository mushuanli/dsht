/** Slash-command syntax: one composer line in, one semantic command out.
 *
 * This module is a pure leaf. It reads no UI facts, performs no effects and imports nothing from the
 * application, so "what the line means" stays separate from "what Enter currently does" (which is
 * `slash/pipeline.ts` in the front end) and from "may this run now" (the pipeline's `authorize`).
 */
import { commandMatches, resolveCommand } from './registry.ts';

import type { Command, LoopOptions } from './types.ts';
export type { Command, LoopOptions } from './types.ts';

/** The numeric options a flag can carry; `vars` is not one, so it stays out of the flag table. */
type LoopNumberOption = 'from' | 'to' | 'score' | 'tries';

/** How each loop flag names an option and validates its value. */
const LOOP_FLAGS: Readonly<Record<string, { key: LoopNumberOption; valid: (value: number) => boolean }>> = {
  '--from': { key: 'from', valid: value => Number.isSafeInteger(value) && value >= 1 },
  '--to': { key: 'to', valid: value => Number.isSafeInteger(value) && value >= 1 },
  '--score': { key: 'score', valid: value => Number.isFinite(value) && value >= 0 && value <= 10 },
  '--tries': { key: 'tries', valid: value => Number.isSafeInteger(value) && value >= 1 },
};

/** The flag that carries one option, so a form keyed by option validates with the same rule. */
const LOOP_OPTION_FLAGS: Readonly<Record<LoopNumberOption, string>> = {
  from: '--from', to: '--to', score: '--score', tries: '--tries',
};

/** Whether one numeric value is acceptable for one loop option.
 *
 * The command line and the interactive form share this rule, so a value the form accepts is exactly
 * one the syntax would have accepted if it had been typed.
 * @param key - Option being set.
 * @param value - Candidate number.
 * @returns True when the option may carry that value.
 */
export function validLoopOption(key: LoopNumberOption, value: number): boolean {
  return LOOP_FLAGS[LOOP_OPTION_FLAGS[key]]!.valid(value);
}

/** The record name the composer is currently typing after `/loop`, if any.
 *
 * The loop-name menu appears while the line is `/loop` or `/loop <one unfinished token>`; a second
 * token means the operator moved on to the flags, so the menu stays out of the way. A trailing space
 * after a complete name still counts: the menu then confirms that name rather than filtering it out.
 * @param line - Composer draft exactly as typed.
 * @returns The unfinished name (empty when none was started), or undefined for any other line.
 */
export function loopNameQuery(line: string): string | undefined {
  if (!line.startsWith('/loop')) return undefined;
  const rest = line.slice('/loop'.length);
  if (rest === '') return '';
  const match = /^[ \t]+(\S*)[ \t]*$/.exec(rest);
  // The subcommands are never records, so the menu must not filter records by them.
  return match?.[1] !== undefined && LOOP_SUBCOMMANDS.includes(match[1]) ? undefined : match?.[1];
}

/** Names `/loop` itself owns, so the record menu never treats one as the start of a record name. */
const LOOP_SUBCOMMANDS = ['stop', 'abort', 'answer'];

/** The one message every malformed `/loop` line receives. */
export const LOOP_USAGE = 'Use /loop <name> [score] [tries] [--from N] [--to N] [--score X] [--tries N]';

/** The one message a malformed `/loop stop` line receives. */
export const LOOP_STOP_USAGE = 'Use /loop stop (no arguments)';

/** The one message a `/loop answer` line without an answer receives. */
export const LOOP_ANSWER_USAGE = 'Use /loop answer <text>';

/** The one message a malformed `/loop abort` line receives. */
export const LOOP_ABORT_USAGE = 'Use /loop abort (no arguments)';

/** Parse `/loop <name> [score] [tries] [flags]`.
 *
 * The name is a record in `loop.yaml`; the syntax layer cannot know which records exist, so it only
 * requires a name that is not a flag and leaves the lookup (and its error, which lists the available
 * names) to the application. Score and tries may be positional or flagged; the last one wins. A line
 * with no name at all is the request to be offered the records instead of typing one; `stop`, `abort`
 * and `answer <text>` are `/loop`'s own subcommands rather than records.
 * @param value - Trimmed line that starts with `/loop`.
 * @returns The command, or the usage error.
 */
function loopCommand(value: string): Command {
  const words = value.slice('/loop'.length).trim().split(/\s+/).filter(Boolean);
  const name = words[0];
  if (name === undefined) return { kind: 'loops' };
  // `stop`, `answer` and `abort` belong to `/loop` itself, which is why a record may not take them.
  if (name === 'stop') return words.length === 1 ? { kind: 'loopStop' } : { kind: 'error', message: LOOP_STOP_USAGE };
  if (name === 'abort') return words.length === 1 ? { kind: 'loopStop' } : { kind: 'error', message: LOOP_ABORT_USAGE };
  if (name === 'answer') {
    const text = words.slice(1).join(' ').trim();
    return text === '' ? { kind: 'error', message: LOOP_ANSWER_USAGE } : { kind: 'loopAnswer', text };
  }
  if (name.startsWith('--')) return { kind: 'error', message: LOOP_USAGE };
  const options: LoopOptions = {};
  let positionals = 0;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word.startsWith('--')) {
      const spec = LOOP_FLAGS[word];
      const raw = words[index + 1];
      if (spec === undefined || raw === undefined) return { kind: 'error', message: LOOP_USAGE };
      const number = Number(raw);
      if (!spec.valid(number)) return { kind: 'error', message: LOOP_USAGE };
      options[spec.key] = number;
      index += 1;
      continue;
    }
    // Two optional positionals: the passing score, then the attempt budget.
    const number = Number(word);
    if (positionals > 1) return { kind: 'error', message: LOOP_USAGE };
    const spec = positionals === 0 ? LOOP_FLAGS['--score']! : LOOP_FLAGS['--tries']!;
    if (!spec.valid(number)) return { kind: 'error', message: LOOP_USAGE };
    options[spec.key] = number;
    positionals += 1;
  }
  return { kind: 'loop', name, options };
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
