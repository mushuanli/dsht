/** Classify one submitted composer line into the action the terminal performs. */
import { navigationCommand } from '../../session/navigation.ts';
import type { State } from '../../state.ts';

/** One classified submission; every side effect stays with the caller. */
export type Submission =
  | { kind: 'ignore' }
  | { kind: 'reference' }
  | { kind: 'copy' }
  | { kind: 'quit' }
  | { kind: 'panel'; panel: 'cost' | 'status' | 'help' }
  | { kind: 'remove'; target: 'workspace' | 'session'; query: string }
  | { kind: 'navigate'; target: 'workspace' | 'session'; query?: string }
  | { kind: 'path'; value: string }
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
  | { kind: 'export'; destination?: string }
  | { kind: 'exportHtml'; destination?: string }
  | { kind: 'answer'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'prompt'; text: string };

/** UI facts the classification reads; everything else stays with the caller. */
export interface SubmissionContext {
  /** Completion menu owns the draft while open. */
  referenceOpen: boolean;
  /** Copy mode ignores submissions entirely. */
  copyMode: boolean;
  /** A question or approval of the selected session is pending. */
  pending: boolean;
  /** The pending interaction is a question. */
  question: boolean;
  screen: State['screen'];
}

/** Classify one composer draft without performing any of its effects.
 *
 * The order of the checks is the command precedence: reference completion, copy mode, the panels
 * that toggle in place, navigation and removal, then the session and host commands, then answers,
 * then a plain prompt.
 * @param raw - Draft exactly as submitted.
 * @param context - Current UI facts.
 * @returns The action to perform.
 */
export function classifySubmission(raw: string, context: SubmissionContext): Submission {
  if (context.referenceOpen) return { kind: 'reference' };
  if (context.copyMode) return { kind: 'ignore' };
  const value = raw.trim();
  if (!value) return { kind: 'ignore' };
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
  if (context.screen === 'path') return { kind: 'path', value };
  if (value === '/latest') return { kind: 'latest' };
  if (/^\/model(?: |$)/.test(value)) {
    if (context.screen !== 'chat') return { kind: 'error', message: 'Select a session first' };
    const args = value.split(/\s+/).slice(1);
    if (args.length && (args.length < 2 || args.length > 3)) return { kind: 'error', message: 'Use /model [provider model [effort]]' };
    return { kind: 'models', args };
  }
  if (value === '/queue') {
    if (context.screen !== 'chat') return { kind: 'error', message: 'Select a session first' };
    if (context.pending) return { kind: 'error', message: 'Answer the pending question or approval first' };
    return { kind: 'queue' };
  }
  if (value === '/new') return { kind: 'newSession' };
  if (value === '/history' || value.startsWith('/history ')) {
    if (context.screen !== 'chat') return { kind: 'error', message: 'Select a session first' };
    return { kind: 'history', query: value.slice(8).trim() };
  }
  if (/^\/(?:search|ssearch|wsearch)(?: |$)/.test(value)) {
    const [command, ...words] = value.split(' ');
    const query = words.join(' ').trim();
    if (!query) return { kind: 'error', message: `Use ${command} <text>` };
    return command === '/search' ? { kind: 'historySearch', query }
      : { kind: 'sessionSearch', command: command as '/ssearch' | '/wsearch', query };
  }
  if (/^\/think(?: |$)/.test(value)) {
    if (context.screen !== 'chat') return { kind: 'error', message: 'Select a session first' };
    return { kind: 'think', target: value.slice(6).trim() };
  }
  if (value === '/older') return { kind: 'older' };
  if (/^\/compact(?: |$)/.test(value)) {
    if (context.screen !== 'chat') return { kind: 'error', message: 'Select a session first' };
    if (value !== '/compact') return { kind: 'error', message: 'Use /compact (no arguments)' };
    return { kind: 'compact' };
  }
  if (value === '/cancel') return { kind: 'cancel' };
  if (value === '/allow') return { kind: 'approval', allowed: true };
  if (value === '/deny') return { kind: 'approval', allowed: false };
  if (/^\/(?:plan|goal|permission|feedback)(?:\s|$)/.test(value)) {
    if (context.screen !== 'chat') return { kind: 'error', message: 'Select a session first' };
    if (context.pending) return { kind: 'error', message: 'Answer the pending question or approval first' };
    return { kind: 'hostCommand', line: value };
  }
  if (/^\/export(?:\s|$)/.test(value)) {
    if (context.screen !== 'chat') return { kind: 'error', message: 'Select a session first' };
    const destination = value.slice(7).trim().replace(/^(["'])(.*)\1$/, '$2');
    return { kind: 'export', ...(destination ? { destination } : {}) };
  }
  if (/^\/export-html(?:\s|$)/.test(value)) {
    if (context.screen !== 'chat') return { kind: 'error', message: 'Select a session first' };
    const destination = value.slice(12).trim().replace(/^(["'])(.*)\1$/, '$2');
    return { kind: 'exportHtml', ...(destination ? { destination } : {}) };
  }
  if (context.question) return { kind: 'answer', text: value };
  if (context.pending) return { kind: 'error', message: 'Answer the approval with /allow or /deny' };
  if (value.startsWith('/')) return { kind: 'error', message: 'Unknown command. Use /help.' };
  if (context.screen !== 'chat') return { kind: 'error', message: 'Choose a session or type /ws or /resume' };
  return { kind: 'prompt', text: value };
}
