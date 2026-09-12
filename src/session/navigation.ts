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

/** Activity a session summary reports on its own, without loading that session's history. */
export type SessionState = 'running' | 'idle' | 'blank';

/** Classify one session from the host's list summary; nothing is inferred from silence.
 * @param session - Session summary from `session/list`.
 * @returns Running while its agent works, blank before its first turn, otherwise idle.
 */
export function sessionState(session: ObjectValue): SessionState {
  if (session.running === true) return 'running';
  return session.blank === true ? 'blank' : 'idle';
}

/** Leading marker per state: a working clock, a filled idle dot, and an empty unused circle. */
export const SESSION_MARKERS: Record<SessionState, string> = { running: '◐', idle: '●', blank: '○' };

/** Coarse age of a session's last activity, so the column stays steady between list refreshes.
 * @param time - Epoch milliseconds of the last activity, when the summary reported one.
 * @param now - Current epoch milliseconds.
 * @returns `now`, minutes, hours or days.
 */
export function activityAge(time: number | undefined, now: number): string {
  if (time === undefined || !Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Status cell for one session row: its state marker and the age of its last activity.
 * @param session - Session summary from `session/list`.
 * @param now - Current epoch milliseconds.
 * @returns Marker with an optional age, without a trailing space when unknown.
 */
export function sessionStatus(session: ObjectValue, now: number): string {
  const age = activityAge(typeof session.updatedAt === 'number' ? session.updatedAt : undefined, now);
  return `${SESSION_MARKERS[sessionState(session)]}${age === '' ? '' : ` ${age}`}`;
}

/** Count the sessions of one workspace by the state each reports.
 * @param sessions - Sessions whose `sessionIds` belong to the workspace.
 * @returns One `marker count` cell per state that occurs, running first, or an empty string.
 */
export function workspaceStatus(sessions: readonly ObjectValue[]): string {
  const counts: Record<SessionState, number> = { running: 0, idle: 0, blank: 0 };
  for (const session of sessions) counts[sessionState(session)] += 1;
  return (['running', 'idle', 'blank'] as const).filter(state => counts[state] > 0)
    .map(state => `${SESSION_MARKERS[state]} ${counts[state]}`).join('  ');
}
