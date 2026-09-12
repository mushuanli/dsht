/** Terminal status from host projections; cumulative usage and estimated context stay distinct. */
import { useTheme, type Theme } from '../theme/index.ts';
import { memo, useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { costText, type CostTotal } from '../../cost/index.ts';
import { toolLine } from '../../session/transcript.ts';
import type { Controller } from '../../controller/controller.ts';
import { safeText, type Json, type ObjectValue } from '../../transport/wire.ts';

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
 * @param values - Current host projection values.
 * @param defaultModel - Host catalog default used before a session selects a route.
 * @param running - Whether the current route or next route is primary.
 * @returns Model, approximate context occupancy, and cumulative token buckets.
 */
export function metricLines(values: ObjectValue, defaultModel: ObjectValue | undefined, running: boolean): string[] {
  const selection = record(values.modelSelection);
  const current = running ? selection.lastUsed ?? selection.next ?? defaultModel : selection.next ?? selection.lastUsed ?? defaultModel;
  const model = modelName(current);
  const next = modelName(selection.next);
  const compact = (value: number | undefined) => value === undefined ? '?' : compactNumber.format(value);
  const pressure = record(values.contextPressure);
  const used = numeric(pressure.projectedTokens) ?? numeric(pressure.pressureTokens);
  const capacity = numeric(pressure.contextWindow);
  const context = used !== undefined && capacity !== undefined && capacity > 0
    ? `~${Math.min(100, Math.round(used / capacity * 100))}% (${compact(used)}/${compact(capacity)})`
    : 'unknown';
  const usage = record(values.tokenUsage);
  const buckets = [usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].map(numeric);
  const total = buckets.every(value => value !== undefined) ? (buckets as number[]).reduce((a, b) => a + b, 0) : undefined;
  return [
    `Model: ${model}${running && next !== 'unknown' && next !== model ? ` · Next: ${next}` : ''}`,
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
  /** This session's cost, the only cost a narrow bar can show beside its other groups. */
  session?: StatusSegment;
  /** Today's cost with the all-time total in parentheses; replaces the session cost where it fits. */
  balance?: StatusSegment;
  /** Context share, labelled because a bare percentage next to money reads as a budget. */
  context?: StatusSegment;
  /** The same share drawn as a bar; used only where it still fits beside every other kept group. */
  contextBar?: StatusSegment;
  /** Model name without its reasoning effort, which is dropped first. */
  model?: StatusSegment;
  /** Reasoning effort, kept only while the model name still fits beside it. */
  effort?: StatusSegment;
  /** Completed turns. */
  turns?: StatusSegment;
  /** Cumulative tokens. */
  tokens?: StatusSegment;
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
  groups = { state: clean(groups.state)!, phase: clean(groups.phase), stop: clean(groups.stop), session: clean(groups.session),
    balance: clean(groups.balance), context: clean(groups.context), contextBar: clean(groups.contextBar),
    model: clean(groups.model), effort: clean(groups.effort), turns: clean(groups.turns), tokens: clean(groups.tokens) };
  const cluster = [groups.state, groups.phase, groups.stop].filter(Boolean) as StatusSegment[];
  // The bar carries one cost slot: the session slice where the ledger has one, otherwise today's cost
  // with the all-time total, because that is then the only cost there is to show.
  const money = groups.session ?? groups.balance;
  // Display order reads the model beside its effort and the money after the share it sits next to;
  // keep order is by value, so a narrow bar holds the cost and the share before a model it cannot show.
  const order = [groups.model, groups.effort, groups.context, money, groups.turns, groups.tokens].filter(Boolean) as StatusSegment[];
  const rank = [money, groups.context, groups.model, groups.effort, groups.turns, groups.tokens].filter(Boolean) as StatusSegment[];
  // One row while enough of the sequence fits; each step drops the least valuable group first.
  // The cost is never dropped, only moved to the second row, so the search stops above it.
  const floor = money === undefined ? 0 : 1;
  for (let keep = rank.length; keep >= floor; keep--) {
    const kept = new Set(rank.slice(0, keep));
    const row = pack(cluster, order.filter(group => kept.has(group)));
    // A bar that has dropped every other group is the compact layout, where the cost keeps the
    // session scope: the day total with the all-time total is the wider reading of the same money.
    if (measure(row) <= width) return [keep > floor ? widen(row, groups, width) : row];
  }
  if (money === undefined && measure(pack(cluster, [])) > width) return [fitCluster(cluster, width)];
  // Not even the state cluster and the cost share a row, so the cost opens the second one.
  return [fitCluster(cluster, width), widen(packGreedy(rank, width), groups, width)];
}

/** Offer the clearer reading of two groups already on the row: the two-scope cost, then the bar.
 *
 * Both are renderings of a value the row already carries, not additional groups, so neither
 * displaces a group that fits: below the width that holds the reading, the plain form keeps its place.
 * @param row - A packed row that already fits.
 * @param groups - Cleaned groups, used to find each pair by identity.
 * @param width - Available terminal columns.
 * @returns The row with the readings that fit.
 */
function widen(row: StatusSegment[], groups: StatusGroups, width: number): StatusSegment[] {
  // The cost's scope answers more than the shape of the share, so it is offered first.
  const cost = swap(row, groups.session, groups.balance, width);
  return swap(cost, groups.context, groups.contextBar, width);
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
export const StatusBar = memo(function StatusBar({ controller, expanded = false, width, scroll = 0, pageSize, onScroll, onOverflow, onRows, pauseReason }:
{ controller: Controller; expanded?: boolean; width?: number; revision?: number; scroll?: number; pageSize?: number;
  onScroll?(next: number): void; onOverflow?(overflow: boolean): void; onRows?(rows: number): void;
  /** Why the display is paused, so a frozen clock can say so instead of looking stalled. */
  pauseReason?: 'copy' | 'dialog' | 'history' }) {
  const paused = pauseReason !== undefined;
  const theme = useTheme();
  const { stdout } = useStdout();
  const [now, setNow] = useState(Date.now);
  const [reported, setReported] = useState(1);
  const running = controller.running;
  const since = controller.workingSince;
  useEffect(() => {
    setNow(Date.now());
    if (paused) return;
    // An idle bar still re-reads the clock, so a day rollover reaches the cost it reports without
    // waiting for an unrelated render; a running bar keeps its per-second clock.
    const timer = setInterval(() => setNow(Date.now()), running ? 1000 : 60_000);
    return () => clearInterval(timer);
  }, [running, since, paused]);
  const state = controller.state;
  const workspace = state.workspaces.find(item => item.workspaceId === state.workspaceId);
  const view = controller.telemetry.view(state.sessionId);
  const costs = controller.costs;
  const sessionCost = costs?.hasSession(state.sessionId) ? costText(costs.total(state.sessionId)) : '?';
  const todayCost = costs ? costText(costs.total(undefined, 1, Date.now())) : '?';
  // `*` belongs to costText alone; incomplete coverage is a separate degradation, reported by `!`.
  const coverage = costs?.coverage ?? 'complete';
  const label = workspace ? `${workspace.title} · ${workspace.path}` : 'none selected';
  if (!expanded) {
    const selection = record(view.values.modelSelection);
    const route = record(running ? selection.lastUsed ?? selection.next ?? state.defaultModel : selection.next ?? selection.lastUsed ?? state.defaultModel);
    const model = typeof route.model === 'string' ? route.model.replace(/^deepseek-/, '') : undefined;
    const effort = typeof route.reasoningEffort === 'string' ? route.reasoningEffort : undefined;
    const pressure = record(view.values.contextPressure);
    const used = numeric(pressure.projectedTokens) ?? numeric(pressure.pressureTokens);
    const capacity = numeric(pressure.contextWindow);
    const percent = used !== undefined && capacity !== undefined && capacity > 0 ? Math.min(100, Math.round(used / capacity * 100)) : undefined;
    const usage = record(view.values.tokenUsage);
    const buckets = [usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].map(numeric);
    const total = buckets.every(value => value !== undefined) ? (buckets as number[]).reduce((a, b) => a + b, 0) : undefined;
    const compactCount = (value: number | undefined) => value === undefined ? '?' : compactNumber.format(value);
    const phase = state.transcript.livePhase;
    const clock = running && since !== undefined ? ` ${clockText(now - since)}` : '';
    const phaseLabel = phase === undefined ? undefined
      : phase.kind === 'tool' ? `${phase.name ?? 'tool'} ${phaseText(now - phase.startedAt)}`
      : `${phase.kind === 'thinking' ? 'think' : 'write'} ${phaseText(now - phase.startedAt)}`;
    // The state token reports a fact and never guesses: a paused clock is named, offline and errors
    // take the token over, and an unknown phase simply leaves the phase group empty.
    const stateToken: StatusSegment = !state.online
      ? { text: '! Offline', color: theme.status.offline }
      : state.controlError || state.modelError
        ? { text: '⚠ Error', color: theme.status.warning }
        : pauseReason !== undefined
          ? { text: `⏸ ${pauseReason}${clock}`, color: theme.colors.muted }
          : running ? { text: `◐${clock}`, color: theme.status.working } : { text: '● Ready', color: theme.status.ready };
    // The marker names the scope it belongs to: a subtotal is inexact when a record could not be
    // priced, or when the scan has not covered every session yet.
    const inexact = coverage !== 'complete';
    const money = (value: CostTotal): string => `¥${value.amount.toFixed(2)}${value.unknown || inexact ? '*' : ''}`;
    // One marker covers both scopes, because either an unpriceable record or an estimate in the day
    // or in the all-time total makes the pair inexact as a reading.
    const balance = (today: CostTotal, all: CostTotal): string =>
      `¥: ${today.amount.toFixed(2)} (${all.amount.toFixed(2)})${today.unknown || all.unknown || inexact ? '*' : ''}`;
    const todayTotal = costs === undefined ? undefined : costs.total(undefined, 1, Date.now());
    const allTotal = costs === undefined ? undefined : costs.total();
    const sessionTotal = costs !== undefined && costs.hasSession(state.sessionId) ? costs.total(state.sessionId) : undefined;
    const contextColor = percent === undefined ? theme.status.usage
      : percent >= 95 ? theme.status.critical : percent >= 80 ? theme.status.warning : theme.status.context;
    // Ten cells resolve context to tenths, the same resolution the percentage beside them reports.
    const cells = percent === undefined ? 0 : Math.round(percent / 10);
    const groups: StatusGroups = {
      state: stateToken,
      // A paused bar keeps the phase: the reason already says why the clock stopped, and dropping the
      // running tool would leave the one question this bar exists to answer unanswered.
      ...(phaseLabel === undefined ? {} : { phase: { text: phaseLabel } }),
      ...(running && pauseReason === undefined ? { stop: { text: '^C' } } : {}),
      ...(sessionTotal === undefined ? {} : { session: { text: `S${money(sessionTotal)}`, color: theme.status.cost } }),
      ...(todayTotal === undefined || allTotal === undefined ? {} : { balance: { text: balance(todayTotal, allTotal), color: theme.status.cost } }),
      ...(percent === undefined ? {} : {
        context: { text: `ctx ${percent}%`, color: contextColor },
        contextBar: { text: `ctx: ${'█'.repeat(cells)}${'░'.repeat(10 - cells)} ~${percent}%`, color: contextColor } }),
      ...(model === undefined ? {} : { model: { text: model, color: theme.status.model } }),
      ...(model === undefined || effort === undefined ? {} : { effort: { text: effort, color: theme.status.model } }),
      ...(numeric(record(view.values.sessionStats).turns) === undefined ? {} : { turns: { text: `${count(numeric(record(view.values.sessionStats).turns))} turns`, color: theme.status.usage } }),
      ...(total === undefined ? {} : { tokens: { text: `${compactCount(total)} tok`, color: theme.status.usage } }),
    };
    const rows = compactStatusRows(groups, width ?? Math.max(1, (stdout.columns ?? 80) - 2));
    if (rows.length !== reported) { setReported(rows.length); onRows?.(rows.length); }
    return <Box flexDirection="column">{rows.map((row, index) => <Text key={index} wrap="truncate-end">
      {row.map((segment, position) => <Text key={position} color={segment.color ?? theme.colors.muted}
        bold={index === 0 && position === 0}>{segment.text}</Text>)}</Text>)}</Box>;
  }
  return <StatusDetails controller={controller} theme={theme} width={width} now={now} scroll={scroll} pageSize={pageSize} onScroll={onScroll} onOverflow={onOverflow} />;
});

/** Expanded detail panel.
 *
 * It is a separate component because it is the only branch that scrolls, and a hook behind the
 * collapsed branch's early return would change the hook order between the two states.
 */
const StatusDetails = memo(function StatusDetails({ controller, theme, width, now, scroll, pageSize, onScroll, onOverflow }:
{ controller: Controller; theme: Theme; width?: number; now: number; scroll: number; pageSize?: number; onScroll?(next: number): void; onOverflow?(overflow: boolean): void }) {
  const { stdout } = useStdout();
  const state = controller.state;
  const running = controller.running;
  const since = controller.workingSince;
  const workspace = state.workspaces.find(item => item.workspaceId === state.workspaceId);
  const view = controller.telemetry.view(state.sessionId);
  const costs = controller.costs;
  const sessionCost = costs?.hasSession(state.sessionId) ? costText(costs.total(state.sessionId)) : '?';
  const todayCost = costs ? costText(costs.total(undefined, 1, Date.now())) : '?';
  // `*` belongs to costText alone; incomplete coverage is a separate degradation, reported by `!`.
  const coverage = costs?.coverage ?? 'complete';
  const label = workspace ? `${workspace.title} · ${workspace.path}` : 'none selected';
  // Every detail row wraps to the terminal width, so a narrow terminal loses nothing; lines that
  // still do not fit are scrolled rather than dropped, because the panel shares the screen height.
  // Rows are merged and labelled compactly so a normal terminal shows every detail on one screen;
  // the wrap and the scroll offset remain the fallback for a short or very narrow terminal.
  const turns = count(numeric(record(view.values.sessionStats).turns));
  const duration = since === undefined ? 'unknown duration' : elapsedTime(now - since);
  const detail: StatusDetail[] = [
    { key: 'activity', color: running ? theme.colors.context : theme.colors.muted, text: running
      ? `◐ Working · ${duration}${state.transcript.activeTurnStartedAt === undefined ? ' (observed)' : ''} · Ctrl+C Stop`
      : '● Ready · Ctrl+C exit' },
    { key: 'host', text: `${safeText(controller.base)} · ${safeText(state.status)}${!state.online ? ' · offline, last known status' : ''}` },
    ...state.sessionId
      ? [{ key: 'session', text: `Session ${safeText(state.sessionId)}${controller.sessionMode ? ` · ${safeText(controller.sessionMode)}` : ''}` }] : [],
    { key: 'workspace', text: `Workspace ${safeText(label)}` },
    ...metricLines(view.values, state.defaultModel, running).map((line, index) => ({ key: `metric-${index}`, text: safeText(line), dim: true })),
    ...costs ? [{ key: 'cost', text: `Cost ${sessionCost} session · ${todayCost} today · ${turns} turns`, dim: true }] : [],
    { key: 'queued', text: `Queued ${count(view.queued)} · Jobs ${count(view.jobs)}${costs ? '' : ` · ${turns} turns`}`, dim: true },
    ...costs && coverage === 'partial'
      ? [{ key: 'coverage', color: theme.colors.context, text: `Cost coverage incomplete: ${costs.error ? safeText(costs.error) : 'no complete scan yet'}` }] : [],
    ...state.controlError ? [{ key: 'control-error', color: theme.colors.context, text: safeText(state.controlError) }] : [],
    ...state.presetError ? [{ key: 'preset-error', color: theme.colors.context, text: `Preset names unavailable: ${safeText(state.presetError)}` }] : [],
    ...state.modelError ? [{ key: 'model-error', color: theme.colors.context, text: `Model catalog unavailable: ${safeText(state.modelError)}` }] : [],
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

function record(value: Json | ObjectValue | undefined): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function numeric(value: Json | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function count(value: number | undefined): string { return value === undefined ? '?' : value.toLocaleString('en-US'); }
function modelName(value: Json | ObjectValue | undefined): string {
  const model = record(value);
  if (typeof model.model !== 'string' || typeof model.provider !== 'string') return 'unknown';
  return safeText(`${model.provider}/${model.model}${typeof model.reasoningEffort === 'string' ? ` (${model.reasoningEffort})` : ''}`);
}

function compactCost(total: CostTotal): string {
  return `~¥${total.amount.toFixed(2)}${total.unknown ? '*' : ''}`;
}
