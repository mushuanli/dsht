/** Read a session row's display label.
 *
 * The host's row already carries the title it projected (`SessionRow.title` in the transport contract),
 * so this leaf only decides the fallback and the printable form; both the domain (matching a target by
 * name) and the UI (labelling a row) read the same rule.
 */
import { safeText } from './text.ts';

/** One row's identity plus the title the host projected for it. */
export interface TitledRow { readonly sessionId: string; readonly title?: string }

/** Resolve the display label, falling back to the session ID. */
export function sessionLabel(session: TitledRow): string {
  const title = typeof session.title === 'string' ? safeText(session.title).trim() : '';
  return title || session.sessionId;
}
