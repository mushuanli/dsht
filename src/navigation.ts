/** Shared display names and unambiguous slash-command target resolution. */
import { safeText, string, type ObjectValue } from './wire.ts';

/** Resolve the host's title projection, falling back to the session ID. */
export function sessionLabel(session: ObjectValue): string {
  const projections = session.projections;
  if (projections && typeof projections === 'object' && !Array.isArray(projections)) {
    const values = projections.values;
    const title = values && typeof values === 'object' && !Array.isArray(values) ? values.title : undefined;
    if (typeof title === 'string' && title) return safeText(title);
    if (title && typeof title === 'object' && !Array.isArray(title) && typeof title.title === 'string') return safeText(title.title);
  }
  return string(session.sessionId);
}

/** Match an exact ID or name before a unique ID prefix; never choose an ambiguous target. */
export function resolveTarget(items: ObjectValue[], query: string, id: string, names: (item: ObjectValue) => string[]): ObjectValue {
  const target = query.replace(/^(["'])(.*)\1$/, '$2');
  const exactId = items.find(item => item[id] === target);
  if (exactId) return exactId;
  const exactNames = items.filter(item => names(item).includes(target));
  const matches = exactNames.length ? exactNames : items.filter(item => string(item[id]).startsWith(target));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Ambiguous target: ${target}. Use a full ID.`);
  throw new Error(`Target not found: ${target}`);
}
