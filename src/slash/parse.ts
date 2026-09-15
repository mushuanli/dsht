/** Slash-command syntax: one composer line in, one semantic command out.
 *
 * This module is a pure leaf. It reads no UI facts, performs no effects and imports nothing from the
 * application, so "what the line means" stays separate from "what Enter currently does" (which is
 * `ui/routing.ts`) and from "may this run now" (which is the application's dispatch).
 */

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
  | { kind: 'history'; query: string }
  | { kind: 'sessionSearch'; command: '/ssearch' | '/wsearch'; query: string }
  | { kind: 'historySearch'; query: string }
  | { kind: 'think'; target: string }
  | { kind: 'older' }
  | { kind: 'compact' }
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
 * @param line - Draft exactly as submitted.
 * @returns The parsed command.
 */
export function parseCommand(line: string): Command {
  const value = line.trim();
  if (!value) return { kind: 'ignore' };
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
  if (value.startsWith('/')) return { kind: 'error', message: 'Unknown command. Use /help.' };
  return { kind: 'prompt', text: value };
}
