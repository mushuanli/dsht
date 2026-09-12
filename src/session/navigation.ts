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

/** User-visible activity of one session, most actionable first.
 *
 * `needs` is the only state that asks the user to do something, and it outranks the host's running
 * flag because a turn waiting on an answer is running only in the mechanical sense. `blank` stays a
 * marker for a session that never sent a turn, but it is not a status and never enters a rollup.
 */
export type SessionState = 'needs' | 'running' | 'idle' | 'blank';

/** Classify one session from the host's list summary; nothing is inferred from silence.
 * @param session - Session summary from `session/list`.
 * @param pending - Whether this client holds an unanswered interaction for that session.
 * @returns Needs-you while an answer is owed, running while its agent works, otherwise idle or blank.
 */
export function sessionState(session: ObjectValue, pending = false): SessionState {
  if (pending) return 'needs';
  if (session.running === true) return 'running';
  return session.blank === true ? 'blank' : 'idle';
}

/** Leading marker per state: a question mark, a working clock, a filled dot, and an unused circle. */
export const SESSION_MARKERS: Record<SessionState, string> = { needs: '?', running: '◐', idle: '●', blank: '○' };

/** One word per state, so every screen names the same state the same way. */
export const STATE_LABELS: Record<SessionState, string> = { needs: 'needs you', running: 'working', idle: 'ready', blank: 'empty' };

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
 * @param pending - Whether this client holds an unanswered interaction for that session.
 * @returns Marker with an optional age, without a trailing space when unknown.
 */
export function sessionStatus(session: ObjectValue, now: number, pending = false): string {
  const age = activityAge(typeof session.updatedAt === 'number' ? session.updatedAt : undefined, now);
  return `${SESSION_MARKERS[sessionState(session, pending)]}${age === '' ? '' : ` ${age}`}`;
}

/** States a workspace rollup reports, most actionable first. */
export const ROLLUP_STATES = ['needs', 'running', 'idle'] as const;

/** One state a workspace rollup reports. */
export type RollupState = (typeof ROLLUP_STATES)[number];

/** One counted state of a workspace rollup. */
export interface RollupCount { state: RollupState; count: number }

/** How much room a rollup has for words. */
export type RollupStyle = 'words' | 'badges';

/** Count the sessions of one workspace by the state each reports.
 *
 * Blank sessions are counted by neither a badge nor a word: a session that never sent a turn is the
 * absence of activity, and listing it beside real work only makes the rollup harder to read.
 * @param sessions - Sessions whose `sessionIds` belong to the workspace.
 * @param pending - Session IDs this client holds an unanswered interaction for.
 * @returns One count per state that occurs, most actionable first, or an empty list.
 */
export function workspaceCounts(sessions: readonly ObjectValue[], pending: ReadonlySet<string> = new Set()): RollupCount[] {
  const counts: Record<RollupState, number> = { needs: 0, running: 0, idle: 0 };
  for (const session of sessions) {
    const id = session.sessionId;
    const state = sessionState(session, typeof id === 'string' && pending.has(id));
    if (state !== 'blank') counts[state] += 1;
  }
  return ROLLUP_STATES.filter(state => counts[state] > 0).map(state => ({ state, count: counts[state] }));
}

/** Render one rollup as separately coloured cells.
 *
 * Each cell after the first carries the separator that joins it to the previous one, so a caller can
 * colour the cells independently without losing the text {@link workspaceStatus} would produce.
 * @param counts - Counts from {@link workspaceCounts}.
 * @param style - `words` spells each state out; `badges` keeps only the marker and the count.
 * @returns The cells in the order given, with their separators.
 */
export function workspaceSegments(counts: readonly RollupCount[], style: RollupStyle = 'words'): { state: RollupState; text: string }[] {
  const separator = style === 'words' ? ' · ' : ' ';
  return counts.map(({ state, count }, index) => ({ state,
    text: `${index === 0 ? '' : separator}${style === 'words' ? `${SESSION_MARKERS[state]} ${count} ${STATE_LABELS[state]}` : `${SESSION_MARKERS[state]}${count}`}` }));
}

/** Render one rollup as plain text, the same way every screen and test reads it.
 * @param counts - Counts from {@link workspaceCounts}.
 * @param style - `words` spells each state out; `badges` keeps only the marker and the count.
 * @returns The joined cell text, empty when nothing was counted.
 */
export function workspaceStatus(counts: readonly RollupCount[], style: RollupStyle = 'words'): string {
  return workspaceSegments(counts, style).map(segment => segment.text).join('');
}

/** Marker key for the compact rollup, which has no room for the words. */
export const ROLLUP_LEGEND = `${SESSION_MARKERS.idle} ${STATE_LABELS.idle} · ${SESSION_MARKERS.running} ${STATE_LABELS.running} · ${SESSION_MARKERS.needs} ${STATE_LABELS.needs}`;

/** Secondary path text for one workspace row.
 *
 * The title is usually the last path segment, so repeating it wastes the row; the parent directory
 * is what distinguishes two checkouts. A title that does not name the last segment keeps the full
 * path, because dropping it would hide where the workspace actually lives.
 * @param path - Registered host directory.
 * @param title - Workspace title as the row already shows it.
 * @returns The path to show beside the row, or an empty string when nothing is left.
 */
export function workspaceDetail(path: string, title: string): string {
  if (!path) return '';
  const trimmed = path.replace(/\/+$/u, '');
  const cut = trimmed.lastIndexOf('/');
  const base = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  if (base !== title) return path;
  if (cut > 0) return trimmed.slice(0, cut);
  return cut === 0 ? '/' : '';
}
