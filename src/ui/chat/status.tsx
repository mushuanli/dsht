/** Terminal status from host projections; cumulative usage and estimated context stay distinct. */
import { useTheme, type Theme } from '../theme/index.ts';
import { memo, useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import type { CostTotal } from '../../contracts.ts';
import { costText } from '../status/model.ts';
import { toolLine } from '../../text.ts';
import type { ClientActivity, Coverage, LivePhase, ModelSelection, SessionMetrics } from '../../contracts.ts';

/** The one reason a status display may stop moving: the reader froze the screen for native selection. */
export type StatusPause = 'copy';

/** One formatted cost scope, with the raw totals the money column needs. */
export interface StatusCostLine { text: string; amount: number; unknown: number }

/** Everything the status bar renders, as plain data the composition root assembles. */
export interface StatusSource {
  /** Host origin, so a reader can tell which deployment the numbers describe. */
  host: string;
  online: boolean;
  status: string;
  running: boolean;
  /** What the client is working on now, merged by the controller: a host turn or a running loop.
   *
   * The bar renders this and never merges sources itself, so "busy", its clock and the loop's
   * sub-state all come from one controller-owned answer.
   */
  activity?: ClientActivity;
  sessionId?: string;
  sessionMode?: string;
  workspaceLabel: string;
  activeTurnStartedAt?: number;
  pendingCount: number;
  /** What the live attempt is doing now, straight from the record. */
  livePhase?: LivePhase;
  /** Decoded host projections for the selected session. */
  metrics: SessionMetrics;
  /** The long operation that owns the client right now, when one does.
   *
   * A controller fact, not a host projection: it is what this client is doing, and the bar names it
   * while the operation runs instead of reporting a state that is only about the turn.
   */
  foreground?: { readonly label: string };
  /** Whether a local `!` run is in flight. Client work the host knows nothing about. */
  shell?: { readonly running: boolean };
  queued?: number;
  jobs?: number;
  defaultModel?: ModelSelection;
  /** Billing summary; absent when this run has no ledger. */
  cost?: {
    sessionText: string;
    /** Read on every render, so a day rollover reaches the bar without an application re-render. */
    today(): StatusCostLine;
    session(): StatusCostLine | undefined;
    coverage: Coverage;
    error?: string;
  };
  controlError?: string;
  presetError?: string;
  modelError?: string;
}
import { safeText } from '../../text.ts';

/** One detail row of the expanded panel before it is wrapped to the terminal width. */
interface StatusDetail { key: string; text: string; color?: string; dim?: boolean }

/** Format elapsed wall time, clamping clock skew instead of displaying negative durations.
 * @param milliseconds - Elapsed duration.
 * @returns Minute/second display, with hours when needed.
 */
export function elapsedTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}h ` : ''}${minutes % 60}m ${seconds % 60}s`;
}

/** Compact token counts; one formatter is reused because construction dominates the format cost. */
const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Produce compact metadata lines without inferring missing provider measurements.
 *
 * Counts use the compact form the single-row bar already uses, because a full count of a long
 * session is eight digits wide and pushes each line past the terminal width on its own.
 * @param metrics - Decoded host projections for the selected session.
 * @param defaultModel - Host catalog default used before a session selects a route.
 * @param running - Whether the current route or next route is primary.
 * @returns Model, approximate context occupancy, and cumulative token buckets.
 */
export function metricLines(metrics: SessionMetrics, defaultModel: ModelSelection | undefined, running: boolean): string[] {
  const { lastUsed, next } = metrics.models;
  const current = running ? lastUsed ?? next ?? defaultModel : next ?? lastUsed ?? defaultModel;
  const model = modelName(current);
  const nextName = modelName(next);
  const compact = (value: number | undefined) => value === undefined ? '?' : compactNumber.format(value);
  const pressure = metrics.context;
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
  const capacity = pressure?.window;
  const context = used !== undefined && capacity !== undefined && capacity > 0
    ? `~${Math.min(100, Math.round(used / capacity * 100))}% (${compact(used)}/${compact(capacity)})`
    : 'unknown';
  const usage = metrics.usage;
  const buckets = [usage?.uncachedInputTokens, usage?.outputTokens, usage?.cacheReadTokens, usage?.cacheWriteTokens];
  const total = buckets.every(value => value !== undefined) ? (buckets as number[]).reduce((a, b) => a + b, 0) : undefined;
  return [
    `Model: ${model}${running && nextName !== 'unknown' && nextName !== model ? ` · Next: ${nextName}` : ''}`,
    `Context ${context} · ${compact(total)} tok`,
    `In ${compact(buckets[0])} · Out ${compact(buckets[1])} · Cache ${compact(buckets[2])}/${compact(buckets[3])}`,
  ];
}

/** The stripe of work the live attempt is in, as the status bar shows it. */
export interface StatusSegment { text: string; color?: string }

/** Every group the single-row bar can show, in the order the packer keeps them. */
export interface StatusGroups {
  /** Always shown: the running clock, Ready, a freeze reason, or the offline/error takeover. */
  state: StatusSegment;
  /** What the live attempt is doing now, e.g. `bash 1:08` or `think 28s`. */
  phase?: StatusSegment;
  /** How to stop the running turn. */
  stop?: StatusSegment;
  /** This session's cost with today's spend in parentheses, the only money the bar reports. */
  cost?: StatusSegment;
  /** Context share, labelled because a bare percentage next to money reads as a budget. */
  context?: StatusSegment;
  /** The same share drawn as a bar; used only where it still fits beside every other kept group. */
  contextBar?: StatusSegment;
  /** Model name without its reasoning effort, which is dropped first. */
  model?: StatusSegment;
  /** Reasoning effort, kept only while the model name still fits beside it. */
  effort?: StatusSegment;
  /** A local `!` run: client work beside the host's, kept while the bar has room for one word. */
  shell?: StatusSegment;
  /** Completed turns. */
  turns?: StatusSegment;
  /** Cumulative tokens. */
  tokens?: StatusSegment;
  /** Cache-hit share of billed prompt input; it restates the token total, so the packer drops it first. */
  cache?: StatusSegment;
}

/** The runtime activity the bar and the panel both read, split by the slot each fact belongs to.
 *
 * Both slots can be filled at once, because the lifecycles coexist: a local `!` run keeps going while
 * the host turn it was typed during is still working. `phase` is chosen by display priority
 * (foreground → loop → paused), `badge` is independent. Callers switch on these fields instead of
 * comparing text, so renaming a badge cannot change whether the bar shows one.
 */
export interface RuntimeActivity {
  /** What belongs beside the clock, when a lifecycle owns that place. */
  readonly phase?: { readonly kind: 'foreground' | 'loop' | 'paused'; readonly text: string };
  /** Client work beside the host's answer: the local `!` run, never instead of the phase. */
  readonly badge?: { readonly kind: 'shell'; readonly text: string };
}

/** What this client is doing right now, in one place.
 *
 * The controller already merges a turn and a loop into `activity`; this adds the two facts that belong
 * to other owners — the foreground operation and a local `!` run — and states the display priority
 * once, so the compact bar and the `/status` panel cannot end up disagreeing about which lifecycle is
 * the current one. Priority is display order only: every lifecycle keeps running behind the named one.
 * @param source - The runtime facts the bar and the panel share.
 * @returns The activity, or undefined when nothing is running.
 */
export function runtimeActivity(source: StatusSource): RuntimeActivity {
  const activity = source.activity;
  // The phase is one winner by display priority; the badge is a fact of its own and fills in parallel.
  const phase = source.foreground !== undefined ? { kind: 'foreground' as const, text: source.foreground.label }
    : activity?.kind === 'loop' ? { kind: 'loop' as const, text: `Loop ${activity.step}/${activity.total} · ${loopActivityText(activity.activity)}` }
    : activity?.kind === 'paused' ? { kind: 'paused' as const, text: 'needs you' }
    // A bare turn has no phase beyond the clock the state token already carries, so naming it here
    // would say "Working" twice; the panel adds that word where there is room for it.
    : undefined;
  return { ...(phase === undefined ? {} : { phase }),
    ...(source.shell?.running === true ? { badge: { kind: 'shell' as const, text: '! shell' } } : {}) };
}

/** One word for what a running loop is waiting on. */
function loopActivityText(activity: 'turn' | 'verify' | 'settle'): string {
  return activity === 'verify' ? 'Verifying' : activity === 'settle' ? 'Settling' : 'Agent';
}

/** Cache-hit share of billed prompt input, without reporting a partial hit as a full one.
 *
 * A prefix served from cache is what the provider charges least for, so the share is the reading
 * that explains a cheap session; rounding it up to `100%` would instead claim that input stopped
 * being billed, so the display gains precision until the number it shows is below a full hit.
 * @param cacheReadTokens - Prompt tokens the provider served from cache.
 * @param billedInputTokens - Uncached input, cache read and cache write, the prompt tokens that were billed.
 * @returns Percentage text, or undefined when no prompt input has been billed yet.
 */
export function cacheHitText(cacheReadTokens: number | undefined, billedInputTokens: number | undefined): string | undefined {
  if (cacheReadTokens === undefined || billedInputTokens === undefined || billedInputTokens <= 0) return undefined;
  if (cacheReadTokens >= billedInputTokens) return '100%';
  for (let digits = 0; digits <= 3; digits++) {
    const text = (cacheReadTokens / billedInputTokens * 100).toFixed(digits);
    if (Number(text) < 100) return `${text}%`;
  }
  return '<100%';
}

/** Elapsed time as `m:ss`, adding hours only when they exist.
 * @param milliseconds - Duration to format.
 * @returns Clock text without a leading zero on minutes.
 */
export function clockText(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Age of a phase, in seconds while it is short and as a clock afterwards.
 * @param milliseconds - Phase duration to format.
 * @returns `28s` below a minute, otherwise `1:08`.
 */
export function phaseText(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : clockText(milliseconds);
}

/** Fit the status groups into one row, or two when the state and the cost cannot share one.
 *
 * Groups are kept by value, not by column: the least valuable group is dropped first, so any width
 * degrades continuously instead of snapping to a fixed layout. The cost is never dropped, only
 * moved to the second row, because it is one of the few answers this bar exists to give.
 * @param groups - Group texts, each already formatted for display.
 * @param width - Available terminal columns.
 * @returns One or two rows of segments; separators carry no colour of their own.
 */
export function compactStatusRows(groups: StatusGroups, width: number): StatusSegment[][] {
  if (width <= 0) return [];
  // Remote text reaches this bar, so every group is stripped of control characters before packing.
  const clean = (group: StatusSegment | undefined): StatusSegment | undefined =>
    group === undefined ? undefined : { ...group, text: safeText(group.text).replace(/[\r\n\t]+/g, ' ') };
  groups = { state: clean(groups.state)!, phase: clean(groups.phase), stop: clean(groups.stop), cost: clean(groups.cost),
    context: clean(groups.context), contextBar: clean(groups.contextBar),
    model: clean(groups.model), effort: clean(groups.effort), shell: clean(groups.shell),
    turns: clean(groups.turns), tokens: clean(groups.tokens), cache: clean(groups.cache) };
  const cluster = [groups.state, groups.phase, groups.stop].filter(Boolean) as StatusSegment[];
  // The cost is one group carrying two scopes: this session's spend, with today's in parentheses.
  // Display order reads the model beside its effort and the money after the share it sits next to;
  // keep order is by value, so a narrow bar holds the cost and the share before a model it cannot
  // show, and the cache share goes before the token total it restates.
  const order = [groups.model, groups.effort, groups.shell, groups.context, groups.cost,
    groups.turns, groups.tokens, groups.cache].filter(Boolean) as StatusSegment[];
  // Rank keeps every existing group in its previous order: a new group may not silently outrank one the
  // bar already promised to keep when it fits.
  const rank = [groups.cost, groups.context, groups.model, groups.effort, groups.turns,
    groups.tokens, groups.shell, groups.cache].filter(Boolean) as StatusSegment[];
  // One row while enough of the sequence fits; each step drops the least valuable group first. The
  // cost is never dropped while a row can hold it, only moved to the second one, so the search stops
  // above it; a second row that cannot hold even the cost is not opened.
  const floor = groups.cost === undefined ? 0 : 1;
  for (let keep = rank.length; keep >= floor; keep--) {
    const kept = new Set(rank.slice(0, keep));
    const row = pack(cluster, order.filter(group => kept.has(group)));
    if (measure(row) <= width) return [keep > floor ? widen(row, groups, width) : row];
  }
  if (groups.cost === undefined && measure(pack(cluster, [])) > width) return [fitCluster(cluster, width)];
  // Not even the state cluster and the cost share a row, so the cost opens the second one.
  const first = fitCluster(cluster, width);
  const second = widen(packGreedy(rank, width), groups, width);
  return second.length === 0 ? [first] : [first, second];
}

/** Offer the clearer reading of a group already on the row: the ten-cell context share.
 *
 * The bar is a rendering of the same share the plain percentage reports, not an additional group, so
 * it never displaces a group that fits: below the width that holds it, the plain form keeps its place.
 * @param row - A packed row that already fits.
 * @param groups - Cleaned groups, used to find the pair by identity.
 * @param width - Available terminal columns.
 * @returns The row with the reading that fits.
 */
function widen(row: StatusSegment[], groups: StatusGroups, width: number): StatusSegment[] {
  return swap(row, groups.context, groups.contextBar, width);
}

/** Replace one group with its fuller rendering where the whole row still fits.
 * @param row - A packed row that already fits.
 * @param from - Group to replace, matched by identity.
 * @param to - Fuller rendering of that group.
 * @param width - Available terminal columns.
 * @returns The row with the replacement, or the row unchanged where it does not fit.
 */
function swap(row: StatusSegment[], from: StatusSegment | undefined, to: StatusSegment | undefined, width: number): StatusSegment[] {
  if (from === undefined || to === undefined) return row;
  const index = row.indexOf(from);
  if (index < 0) return row;
  const replaced = [...row.slice(0, index), to, ...row.slice(index + 1)];
  return measure(replaced) <= width ? replaced : row;
}

/** Fit the state cluster, dropping the phase and then the stop hint before truncating the state.
 * @param cluster - State, phase and stop hint in that order.
 * @param width - Available terminal columns.
 * @returns The cluster as far as it fits.
 */
function fitCluster(cluster: StatusSegment[], width: number): StatusSegment[] {
  for (let keep = cluster.length; keep >= 1; keep--) {
    const row = pack(cluster.slice(0, keep), []);
    if (measure(row) <= width) return row;
  }
  const [first] = cluster;
  return first === undefined ? [] : [{ ...first, text: toolLine(first.text, width) }];
}

/** Join the state cluster and the groups that follow it with their boundary separator.
 * @param cluster - State, phase and stop hint, separated by middots.
 * @param rest - Remaining groups, separated from the cluster by a bar.
 * @returns The packed row.
 */
function pack(cluster: StatusSegment[], rest: StatusSegment[]): StatusSegment[] {
  return [...cluster, ...rest].flatMap((group, index) => index === 0 ? [group]
    : [{ text: index === cluster.length ? ' │ ' : ' · ' }, group]);
}

/** Add leading groups while they fit, stopping at the first that does not.
 * @param groups - Groups in keep order.
 * @param width - Available terminal columns.
 * @returns The groups that fit.
 */
function packGreedy(groups: StatusSegment[], width: number): StatusSegment[] {
  let row: StatusSegment[] = [];
  for (const group of groups) {
    const next = row.length === 0 ? [group] : [...row, { text: ' · ' }, group];
    if (measure(next) > width) break;
    row = next;
  }
  return row;
}

/** Join groups with a separator, keeping the separator uncoloured.
 * @param groups - Groups to join.
 * @param separator - Separator text between them.
 * @returns The groups with separators interleaved.
 */
function joinSegments(groups: StatusSegment[], separator: string): StatusSegment[] {
  return groups.flatMap((group, index) => index === 0 ? [group] : [{ text: separator }, group]);
}

/** Display width of one packed row, so wide characters count as two columns.
 * @param row - Segments already joined with their separators.
 * @returns Columns the row occupies.
 */
function measure(row: StatusSegment[]): number {
  return row.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
}

/** Render a live clock and selected-session metadata; the timer belongs to this mounted bar. */
export const StatusBar = memo(function StatusBar({ source, expanded = false, width, scroll = 0, pageSize, onScroll, onOverflow, onRows, pauseReason }:
{ source: StatusSource; expanded?: boolean; width?: number; revision?: number; scroll?: number; pageSize?: number;
  onScroll?(next: number): void; onOverflow?(overflow: boolean): void; onRows?(rows: number): void;
  /** Why the *display* is frozen. Only copy mode stops time.
   *
   * A panel is another view of live state, not a pause: freezing the clock behind `/help` or `/status`
   * would print a reading that stopped being true, so the runtime projection keeps moving and only the
   * screen itself is held.
   */
  pauseReason?: StatusPause }) {
  const paused = pauseReason !== undefined;
  const theme = useTheme();
  const { stdout } = useStdout();
  const [now, setNow] = useState(Date.now);
  const [reported, setReported] = useState(1);
  const running = source.running;
  const activity = source.activity;
  // The controller already merged a turn and a loop into one answer; the bar only draws it, plus the
  // foreground operation and the local shell, which are the other two owners of "what is happening".
  const foreground = source.foreground;
  const shellRunning = source.shell?.running === true;
  const busy = activity !== undefined || foreground !== undefined || shellRunning;
  const since = activity?.kind === 'turn' ? activity.since : activity?.kind === 'loop' ? activity.startedAt : undefined;
  useEffect(() => {
    setNow(Date.now());
    if (paused) return;
    // An idle bar still re-reads the clock, so a day rollover reaches the cost it reports without
    // waiting for an unrelated render; a busy bar keeps its per-second clock.
    const timer = setInterval(() => setNow(Date.now()), busy ? 1000 : 60_000);
    return () => clearInterval(timer);
  }, [busy, since, paused]);
  const state = source;
  const metrics = source.metrics;
  const view = { queued: source.queued, jobs: source.jobs };
  const costs = source.cost;
  const sessionCost = source.cost?.sessionText ?? '?';
  // `*` belongs to costText alone; incomplete coverage is a separate degradation, reported by `!`.
  const coverage = source.cost?.coverage ?? 'complete';
  const label = source.workspaceLabel;
  if (!expanded) {
    const { lastUsed, next } = metrics.models;
    const route = (running ? lastUsed ?? next : next ?? lastUsed) ?? state.defaultModel;
    const model = route?.model.replace(/^deepseek-/, '');
    const effort = route?.reasoningEffort;
    const pressure = metrics.context;
    const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
    const capacity = pressure?.window;
    const percent = used !== undefined && capacity !== undefined && capacity > 0 ? Math.min(100, Math.round(used / capacity * 100)) : undefined;
    const usage = metrics.usage;
    const buckets = [usage?.uncachedInputTokens, usage?.outputTokens, usage?.cacheReadTokens, usage?.cacheWriteTokens];
    const total = buckets.every(value => value !== undefined) ? (buckets as number[]).reduce((a, b) => a + b, 0) : undefined;
    // Billed prompt input is the three disjoint prompt buckets; a provider that reports no cache
    // write has not billed one, which is how the ledger reads the same projection.
    const billed = buckets[0] === undefined || buckets[2] === undefined ? undefined : buckets[0] + buckets[2] + (buckets[3] ?? 0);
    const hit = cacheHitText(buckets[2], billed);
    const compactCount = (value: number | undefined) => value === undefined ? '?' : compactNumber.format(value);
    const phase = source.livePhase;
    const clock = busy && since !== undefined ? ` ${clockText(now - since)}` : '';
    const phaseLabel = phase === undefined ? undefined
      : phase.kind === 'tool' ? `${phase.name ?? 'tool'} ${phaseText(now - phase.startedAt)}`
      : `${phase.kind === 'thinking' ? 'think' : 'write'} ${phaseText(now - phase.startedAt)}`;
    // A host turn's phase wins; without one, the shared activity projection names what the client is
    // doing, so the bar never reports an idle session while a review or an export is in flight. The
    // shell badge has its own group, because it is client work beside the host's rather than the thing
    // the clock is measuring.
    const projected = runtimeActivity(source);
    const phaseSegment: StatusSegment | undefined = !busy ? undefined
      : phaseLabel !== undefined ? { text: phaseLabel }
      : projected.phase === undefined ? undefined : { text: projected.phase.text };
    // The state token reports a fact and never guesses: a paused clock is named, offline and errors
    // take the token over, and an unknown phase simply leaves the phase group empty. An answer this
    // client still owes outranks the paused reason, because that reason is only why the clock stopped.
    // A degraded metadata load names the subsystem it broke, so the bar itself answers "what is
    // wrong" and the expanded panel only has to add the message. Live metrics lead because the rest
    // of the bar reads them; presets are the quietest of the three and never hide a louder failure.
    const degraded = source.controlError !== undefined ? '⚠ Metrics'
      : source.modelError !== undefined ? '⚠ Models'
      : source.presetError !== undefined ? '⚠ Presets' : undefined;
    const stateToken: StatusSegment = !source.online
      ? { text: '! Offline', color: theme.status.offline }
      : degraded !== undefined
        ? { text: degraded, color: theme.status.warning }
        : source.pendingCount > 0
          ? { text: '? Needs you', color: theme.status.critical }
          : pauseReason !== undefined
            ? { text: `⏸ ${pauseReason}${clock}`, color: theme.colors.muted }
            : activity?.kind === 'paused' ? { text: '⏸ needs you', color: theme.status.critical }
            : busy ? { text: `◐${clock}`, color: theme.status.working } : { text: '● Ready', color: theme.status.ready };
    // One marker covers both scopes, because either an unpriceable record or a scan that has not
    // covered every session makes the pair inexact as a reading.
    const inexact = coverage !== 'complete';
    const money = (session: StatusCostLine | undefined, today: StatusCostLine): string =>
      `¥: ${session === undefined ? '?' : session.amount.toFixed(2)}(${today.amount.toFixed(2)})${session?.unknown || today.unknown || inexact ? '*' : ''}`;
    // Read here rather than from a snapshot, so the bar's own clock drives a day rollover.
    const todayTotal = costs?.today();
    const sessionTotal = costs?.session();
    const contextColor = percent === undefined ? theme.status.usage
      : percent >= 95 ? theme.status.critical : percent >= 80 ? theme.status.warning : theme.status.context;
    // Ten cells resolve context to tenths, the same resolution the percentage beside them reports.
    const cells = percent === undefined ? 0 : Math.round(percent / 10);
    const groups: StatusGroups = {
      state: stateToken,
      // A paused bar keeps the phase: the reason already says why the clock stopped, and dropping the
      // running tool would leave the one question this bar exists to answer unanswered. A bar with no
      // work of its own has none: the transcript keeps the last event it saw, and only the host knows
      // the turn ended.
      ...(phaseSegment === undefined ? {} : { phase: phaseSegment }),
      ...(busy && pauseReason === undefined ? { stop: { text: '^C' } } : {}),
      ...(todayTotal === undefined ? {} : { cost: { text: money(sessionTotal, todayTotal), color: theme.status.cost } }),
      ...(percent === undefined ? {} : {
        context: { text: `ctx ${percent}%`, color: contextColor },
        contextBar: { text: `ctx: ${'█'.repeat(cells)}${'░'.repeat(10 - cells)} ~${percent}%`, color: contextColor } }),
      ...(model === undefined ? {} : { model: { text: model, color: theme.status.model } }),
      ...(model === undefined || effort === undefined ? {} : { effort: { text: effort, color: theme.status.model } }),
      // A local `!` run is client work: it is named beside the host's answer, never instead of it.
      ...(projected.badge === undefined ? {} : { shell: { text: projected.badge.text, color: theme.colors.context } }),
      ...(metrics.turns === undefined ? {} : { turns: { text: `${count(metrics.turns)} turns`, color: theme.status.usage } }),
      ...(total === undefined ? {} : { tokens: { text: `${compactCount(total)} tok`, color: theme.status.usage } }),
      ...(hit === undefined ? {} : { cache: { text: `hit ${hit}`, color: theme.status.usage } }),
    };
    const rows = compactStatusRows(groups, width ?? Math.max(1, (stdout.columns ?? 80) - 2));
    if (rows.length !== reported) { setReported(rows.length); onRows?.(rows.length); }
    return <Box flexDirection="column">{rows.map((row, index) => <Text key={index} wrap="truncate-end">
      {row.map((segment, position) => <Text key={position} color={segment.color ?? theme.colors.muted}
        bold={index === 0 && position === 0}>{segment.text}</Text>)}</Text>)}</Box>;
  }
  return <StatusDetails source={source} theme={theme} width={width} now={now} scroll={scroll} pageSize={pageSize} onScroll={onScroll} onOverflow={onOverflow} />;
});

/** Expanded detail panel.
 *
 * It is a separate component because it is the only branch that scrolls, and a hook behind the
 * collapsed branch's early return would change the hook order between the two states.
 */
const StatusDetails = memo(function StatusDetails({ source, theme, width, now, scroll, pageSize, onScroll, onOverflow }:
{ source: StatusSource; theme: Theme; width?: number; now: number; scroll: number; pageSize?: number; onScroll?(next: number): void; onOverflow?(overflow: boolean): void }) {
  const { stdout } = useStdout();
  const state = source;
  const running = source.running;
  const activity = source.activity;
  const busy = activity !== undefined;
  const since = activity?.kind === 'turn' ? activity.since : activity?.kind === 'loop' ? activity.startedAt : undefined;
  const metrics = source.metrics;
  const view = { queued: source.queued, jobs: source.jobs };
  const costs = source.cost;
  const sessionCost = source.cost?.sessionText ?? '?';
  const todayCost = source.cost?.today().text ?? '?';
  // `*` belongs to costText alone; incomplete coverage is a separate degradation, reported by `!`.
  const coverage = source.cost?.coverage ?? 'complete';
  const label = source.workspaceLabel;
  // Every detail row wraps to the terminal width, so a narrow terminal loses nothing; lines that
  // still do not fit are scrolled rather than dropped, because the panel shares the screen height.
  // Rows are merged and labelled compactly so a normal terminal shows every detail on one screen;
  // the wrap and the scroll offset remain the fallback for a short or very narrow terminal.
  const turns = count(metrics.turns);
  const duration = since === undefined ? 'unknown duration' : elapsedTime(now - since);
  const projected = runtimeActivity(source);
  const detail: StatusDetail[] = [
    // The same projection the bar shows, so the two can never name different lifecycles. The panel adds
    // what the bar has no width for: the clock, the cancel key, and the loop's own title.
    { key: 'activity', color: source.pendingCount > 0 ? theme.status.critical
      : source.foreground !== undefined ? theme.status.working
      : busy ? theme.colors.context : theme.colors.muted, text: source.pendingCount > 0
      ? '? Needs you · answer the request above to continue'
      : source.foreground !== undefined
        ? `◐ ${source.foreground.label} · Esc cancel`
      : running
        ? `◐ ${projected.phase?.text ?? 'Working'} · ${duration}${source.activeTurnStartedAt === undefined ? ' (observed)' : ''} · Ctrl+C Stop`
        : activity?.kind === 'loop'
          ? `◐ ${projected.phase?.text ?? `Loop ${activity.step}/${activity.total}`} · ${duration} · Ctrl+C Stop`
          : activity?.kind === 'paused'
            ? `⏸ ${activity.title} · needs you · /loop answer <text> or /loop abort`
            : projected.badge !== undefined
              ? `◐ ${projected.badge.text} · client-side command`
              : '● Ready · Ctrl+C exit' },
    { key: 'host', text: `${safeText(source.host)} · ${safeText(state.status)}${!source.online ? ' · offline, last known status' : ''}` },
    ...source.sessionId
      ? [{ key: 'session', text: `Session ${safeText(source.sessionId)}${source.sessionMode ? ` · ${safeText(source.sessionMode)}` : ''}` }] : [],
    { key: 'workspace', text: `Workspace ${safeText(label)}` },
    ...metricLines(metrics, source.defaultModel, running).map((line, index) => ({ key: `metric-${index}`, text: safeText(line), dim: true })),
    ...costs ? [{ key: 'cost', text: `Cost ${sessionCost} session · ${todayCost} today · ${turns} turns`, dim: true }] : [],
    { key: 'queued', text: `Queued ${count(view.queued)} · Jobs ${count(view.jobs)}${costs ? '' : ` · ${turns} turns`}`, dim: true },
    ...costs && coverage === 'partial'
      ? [{ key: 'coverage', color: theme.colors.context, text: `Cost coverage incomplete: ${costs.error ? safeText(costs.error) : 'no complete scan yet'}` }] : [],
    ...source.controlError ? [{ key: 'control-error', color: theme.colors.context, text: safeText(source.controlError) }] : [],
    ...source.presetError ? [{ key: 'preset-error', color: theme.colors.context, text: `Preset names unavailable: ${safeText(source.presetError)}` }] : [],
    ...source.modelError ? [{ key: 'model-error', color: theme.colors.context, text: `Model catalog unavailable: ${safeText(source.modelError)}` }] : [],
  ];
  // Border and horizontal padding take four columns, so a detail row wraps inside what is left.
  const inner = Math.max(1, (width ?? Math.max(3, (stdout.columns ?? 80) - 2)) - 4);
  const measured = (text: string) => wrapAnsi(text, inner, { trim: false, hard: true }).split('\n').length;
  const lines = detail.flatMap(row => wrapAnsi(row.text, inner, { trim: false, hard: true }).split('\n')
    .map((text, index) => ({ ...row, key: `${row.key}:${index}`, text })));
  const budget = Math.max(1, pageSize ?? lines.length);
  const hint = (first: number, last: number, total: number) => `Status ${first}-${last}/${total} · ↑↓ scroll · Esc close`;
  // A footer that wraps takes rows from the view, so its height is reserved before sizing it.
  const size = Math.max(1, budget - (lines.length > budget ? measured(hint(0, 0, lines.length)) : 0));
  const start = Math.max(0, Math.min(scroll, Math.max(0, lines.length - size)));
  // Arrows and the wheel can ask for a line past either end; report the settled position back.
  useEffect(() => { if (start !== scroll) onScroll?.(start); }, [start, scroll, onScroll]);
  // The caller needs to know whether this panel owns the arrows or has nothing to scroll.
  useEffect(() => { onOverflow?.(lines.length > size); }, [lines.length, size, onOverflow]);
  const visible = lines.slice(start, start + size);
  return <Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1}>
    {visible.map(line => <Text key={line.key} color={line.color} dimColor={line.dim}>{line.text}</Text>)}
    {lines.length > size && <Text dimColor>{hint(start + 1, start + visible.length, lines.length)}</Text>}
  </Box>;
});

function count(value: number | undefined): string { return value === undefined ? '?' : value.toLocaleString('en-US'); }
/** Name one selected route the way the bar shows it; an unset route reads `unknown`. */
function modelName(selection: ModelSelection | undefined): string {
  if (selection === undefined) return 'unknown';
  return safeText(`${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` (${selection.reasoningEffort})`}`);
}

function compactCost(total: CostTotal): string {
  return `~¥${total.amount.toFixed(2)}${total.unknown ? '*' : ''}`;
}
