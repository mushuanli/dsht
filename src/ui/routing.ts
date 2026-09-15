/** Decide what the Enter key means right now, before the line is parsed as a command.
 *
 * Routing owns the UI facts — an open completion menu, copy mode, a waiting answer, the current
 * screen — while `slash/parse.ts` owns the syntax. A screen guard only decides whether a parsed
 * command may run here, never what the command is.
 */
import { parseCommand, type Command } from '../slash/index.ts';

/** What the composer should do with one submitted line. */
export type Routed =
  | { kind: 'ignore' }
  | { kind: 'reference' }
  | { kind: 'answer'; text: string }
  | { kind: 'path'; value: string }
  | Command;

/** Commands that only make sense with a selected conversation. */
const CHAT_ONLY = new Set(['shell', 'models', 'queue', 'history', 'think', 'compact', 'hostCommand', 'export', 'exportHtml']);

/** Commands that must wait until the pending approval or question is settled. */
const BLOCKED_BY_PENDING = new Set(['queue', 'hostCommand']);

/** Current UI facts routing reads; nothing else is needed. */
export interface RouteFacts {
  line: string;
  /** The `@` completion menu owns the draft while open. */
  referenceOpen: boolean;
  /** Copy mode freezes the display and ignores submissions. */
  copyMode: boolean;
  /** An approval or question of the selected session is waiting. */
  pending: boolean;
  /** The waiting interaction is a question, so free text answers it. */
  question: boolean;
  screen: 'workspaces' | 'sessions' | 'chat' | 'path';
}

/** Decide what one submitted line means.
 * @param facts - Current UI facts.
 * @returns The action the composer should take.
 */
export function routeEnter(facts: RouteFacts): Routed {
  if (facts.referenceOpen) return { kind: 'reference' };
  if (facts.copyMode) return { kind: 'ignore' };
  const value = facts.line.trim();
  if (!value) return { kind: 'ignore' };
  if (value.startsWith('/') || value.startsWith('!')) {
    const command = parseCommand(value);
    if (command.kind === 'error' || command.kind === 'ignore') return command;
    if (facts.screen !== 'chat' && CHAT_ONLY.has(command.kind)) return { kind: 'error', message: 'Select a session first' };
    if (facts.pending && BLOCKED_BY_PENDING.has(command.kind)) return { kind: 'error', message: 'Answer the pending question or approval first' };
    return command;
  }
  // A question takes free text as its answer; an approval keeps every choice explicit.
  if (facts.question) return { kind: 'answer', text: value };
  if (facts.pending) return { kind: 'error', message: 'Answer the approval with /allow or /deny' };
  if (facts.screen === 'path') return { kind: 'path', value };
  if (facts.screen !== 'chat') return { kind: 'error', message: 'Choose a session or type /ws or /resume' };
  return { kind: 'prompt', text: value };
}
