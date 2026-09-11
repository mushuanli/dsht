/** Terminal status from host projections; cumulative usage and estimated context stay distinct. */
import { useTheme, type Theme } from '../theme/index.ts';
import { memo, useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import wrapAnsi from 'wrap-ansi';
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

/** Produce compact metadata lines without inferring missing provider measurements.
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
  const pressure = record(values.contextPressure);
  const used = numeric(pressure.projectedTokens) ?? numeric(pressure.pressureTokens);
  const capacity = numeric(pressure.contextWindow);
  const context = used !== undefined && capacity !== undefined && capacity > 0
    ? `~${Math.min(100, Math.round(used / capacity * 100))}% (${count(used)}/${count(capacity)})`
    : 'unknown';
  const usage = record(values.tokenUsage);
  const buckets = [usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].map(numeric);
  const total = buckets.every(value => value !== undefined) ? (buckets as number[]).reduce((a, b) => a + b, 0) : undefined;
  return [
    `Model: ${model}${running && next !== 'unknown' && next !== model ? ` · Next: ${next}` : ''}`,
    `Context ${context} · ${count(total)} tok`,
    `In ${count(buckets[0])} · Out ${count(buckets[1])} · Cache ${count(buckets[2])}/${count(buckets[3])}`,
  ];
}

/** Fit the status summary to one terminal row; details remain available through /status.
 * @param fields - Activity, model, cost, context, and cumulative usage groups in display order.
 * @param width - Available terminal columns.
 * @returns A terminal-safe single line, shortened by display width.
 */
export function compactStatus(fields: string[], width: number): string {
  return compactStatusFields(fields, width).filter(Boolean).join('   ');
}

/** Keep group identities while fitting plain text; ANSI styling is applied only after layout. */
function compactStatusFields(fields: string[], width: number): string[] {
  if (width <= 0) return [];
  const clean = fields.map(value => safeText(value).replace(/[\r\n\t]/g, ' '));
  const join = () => clean.filter(Boolean).join('   ');
  const fits = () => !wrapAnsi(join(), width, { hard: true, wordWrap: false, trim: false }).includes('\n');
  if (fits()) return clean;
  // Keep the stable activity column while it fits; reclaim it on narrow terminals.
  clean[0] = clean[0]?.trimEnd() ?? '';
  if (fits()) return clean;
  clean[3] = (clean[3] ?? '').replace(/[█░]+ /u, '');
  if (fits()) return clean;
  clean[1] = toolLine(clean[1] ?? '', Math.max(8, Math.min(24, Math.floor(width / 4))));
  if (fits()) return clean;
  for (const index of [4, 2, 1, 3]) {
    clean[index] = '';
    if (fits()) return clean;
  }
  return [toolLine(join(), width)];
}

/** Compact token counts; one formatter is reused because construction dominates the format cost. */
const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Render a live clock and selected-session metadata; the timer belongs to this mounted bar. */
export const StatusBar = memo(function StatusBar({ controller, expanded = false, width, scroll = 0, pageSize, onScroll, paused = false }: { controller: Controller; expanded?: boolean; width?: number; revision?: number; scroll?: number; pageSize?: number; onScroll?(next: number): void; paused?: boolean }) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const [now, setNow] = useState(Date.now);
  const running = controller.running;
  const since = controller.workingSince;
  useEffect(() => {
    setNow(Date.now());
    if (!running || paused) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
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
    const model = typeof route.model === 'string' ? `${route.model.replace(/^deepseek-/, '')}${typeof route.reasoningEffort === 'string' ? ` · ${route.reasoningEffort}` : ''}` : 'model ?';
    const pressure = record(view.values.contextPressure);
    const used = numeric(pressure.projectedTokens) ?? numeric(pressure.pressureTokens);
    const capacity = numeric(pressure.contextWindow);
    const percent = used !== undefined && capacity !== undefined && capacity > 0 ? Math.min(100, Math.round(used / capacity * 100)) : undefined;
    const filled = percent === undefined ? 0 : Math.round(percent / 10);
    const context = percent === undefined ? 'ctx ?' : `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ~${percent}%`;
    const usage = record(view.values.tokenUsage);
    const buckets = [usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].map(numeric);
    const total = buckets.every(value => value !== undefined) ? (buckets as number[]).reduce((a, b) => a + b, 0) : undefined;
    const compactCount = (value: number | undefined) => value === undefined ? '?' : compactNumber.format(value);
    const activity = running ? `◐ Working · ${since === undefined ? '?' : elapsedTime(now - since)}${state.transcript.activeTurnStartedAt === undefined ? '~' : ''} · Ctrl+C Stop` : '● Ready';
    const warning = state.controlError || state.modelError || coverage === 'partial' ? '! ' : '';
    const fields = [
      `${warning}${!state.online ? 'Offline · ' : ''}${activity}`.padEnd(31),
      model,
      costs ? `${costs.hasSession(state.sessionId) ? compactCost(costs.total(state.sessionId)) : '?'}/${compactCost(costs.total(undefined, 1, Date.now()))}` : '?/?',
      context,
      `${count(numeric(record(view.values.sessionStats).turns))} turns · ${compactCount(total)} tok`,
    ];
    const fitted = compactStatusFields(fields, width ?? Math.max(1, (stdout.columns ?? 80) - 2));
    const colors = [
      !state.online ? theme.status.offline : warning ? theme.status.warning : running ? theme.status.working : theme.status.ready,
      theme.status.model, costs ? theme.status.cost : theme.status.usage,
      percent === undefined ? theme.status.usage : percent >= 95 ? theme.status.critical : percent >= 80 ? theme.status.warning : theme.status.context,
      theme.status.usage,
    ];
    return <Text wrap="truncate-end">{fitted.map((text, index) => text ? <Text key={index}>
      {fitted.slice(0, index).some(Boolean) && <Text color={theme.colors.muted}>{'   '}</Text>}
      <Text color={colors[index]} bold={index === 0}>{text}</Text>
    </Text> : null)}</Text>;
  }
  return <StatusDetails controller={controller} theme={theme} width={width} now={now} scroll={scroll} pageSize={pageSize} onScroll={onScroll} />;
});

/** Expanded detail panel.
 *
 * It is a separate component because it is the only branch that scrolls, and a hook behind the
 * collapsed branch's early return would change the hook order between the two states.
 */
const StatusDetails = memo(function StatusDetails({ controller, theme, width, now, scroll, pageSize, onScroll }:
{ controller: Controller; theme: Theme; width?: number; now: number; scroll: number; pageSize?: number; onScroll?(next: number): void }) {
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
  return `~¥${total.amount.toFixed(2)}${total.unknown || total.estimated ? '*' : ''}`;
}
