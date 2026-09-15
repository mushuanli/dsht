/** Read a session summary's display title.
 *
 * Host rows carry their title inside a projection, and both the domain (matching a target by name)
 * and the UI (labelling a row) need the same reading, so it lives in its own leaf rather than in
 * either layer.
 */
import { string, type ObjectValue } from './json.ts';
import { safeText } from './text.ts';

/** Resolve the host's title projection, falling back to the session ID. */
export function sessionLabel(session: ObjectValue): string {
  const projections = session.projections;
  if (projections && typeof projections === 'object' && !Array.isArray(projections)) {
    const values = projections.values;
    const title = values && typeof values === 'object' && !Array.isArray(values) ? values.title : undefined;
    if (typeof title === 'string' && safeText(title).trim()) return safeText(title).trim();
    if (title && typeof title === 'object' && !Array.isArray(title) && typeof title.title === 'string' && safeText(title.title).trim()) return safeText(title.title).trim();
  }
  return string(session.sessionId);
}
