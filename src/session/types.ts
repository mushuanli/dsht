/** Session-domain result types shared by the controller facade and the terminal UI. */
import type { QuestionItem } from '../transport/events.ts';

/** Resolved navigation-removal identity; empty marks a fresh blank, idle session eligible for immediate archival. */
export interface RemovalTarget { kind: 'workspace' | 'session'; id: string; name: string; path?: string; empty?: boolean }

/** Bounded search results contain navigation summaries, never complete message bodies. */
export interface HistorySearch {
  items: { seq: number; role: string; preview: string }[];
  truncated: boolean;
}

/** A structured question answer as the UI collects it; the host receives it inside an outcome. */
export type AnswerValue = { answers: { id: string; selected: string[]; custom?: string }[] };

/** One unanswered host interaction of the selected session.
 *
 * A discriminated union rather than the raw waterfall: the UI switches on `kind` and reads named
 * fields, so it never needs to know how the host shaped its request.
 */
export type PendingInteraction =
  | { kind: 'approval'; eventId: string; sessionId: string; description: string }
  | { kind: 'question'; eventId: string; sessionId: string; questions: readonly QuestionItem[] };

