/** Shared display names and unambiguous slash-command target resolution. */
import { safeText, string, type ObjectValue } from '../transport/wire.ts';

/** Parse workspace and resume navigation, including their long aliases. */
export function navigationCommand(value: string): { kind: 'workspace' | 'session'; query?: string } | undefined {
  const match = /^\/(ws|workspace|workspaces|resume|session|sessions)(?:\s+(.+))?$/.exec(value);
  if (!match) return undefined;
  return { kind: match[1] === 'ws' || match[1]!.startsWith('workspace') ? 'workspace' : 'session', query: match[2] };
}

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
