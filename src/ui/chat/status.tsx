/** Terminal status from host projections; cumulative usage and estimated context stay distinct. */
import { useTheme } from '../theme/index.ts';
import { memo, useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { costText, type CostTotal } from '../../cost/ledger.ts';
import { toolLine } from '../../session/transcript.ts';
import type { Controller } from '../../controller/controller.ts';
import { safeText, type Json, type ObjectValue } from '../../transport/wire.ts';

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
    ? `~${Math.min(100, Math.round(used / capacity * 100))}% (${count(used)} / ${count(capacity)})`
    : 'unknown';
  const usage = record(values.tokenUsage);
  const buckets = [usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].map(numeric);
  const total = buckets.every(value => value !== undefined) ? (buckets as number[]).reduce((a, b) => a + b, 0) : undefined;
  return [
    `Model: ${model}${running && next !== 'unknown' && next !== model ? ` · Next: ${next}` : ''}`,
    `Context: ${context} · Tokens: ${count(total)} total`,
    `In (uncached): ${count(buckets[0])} · Out: ${count(buckets[1])} · Cache read/write: ${count(buckets[2])}/${count(buckets[3])}`,
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
export const StatusBar = memo(function StatusBar({ controller, expanded = false, width, paused = false }: { controller: Controller; expanded?: boolean; width?: number; revision?: number; paused?: boolean }) {
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
  return <Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1}>
    <Text color={running ? theme.colors.context : theme.colors.muted}>{running
      ? `◐ Working · ${since === undefined ? 'unknown duration' : elapsedTime(now - since)}${state.transcript.activeTurnStartedAt === undefined ? ' (observed)' : ''} · Ctrl+C Stop`
      : '● Ready · Ctrl+C exit'}{!state.online ? ' · disconnected, last known status' : ''}</Text>
    <Text wrap="truncate-end">Host: {safeText(controller.base)} · {safeText(state.status)}</Text>
    {state.sessionId && <Text>Session ID: {safeText(state.sessionId)}</Text>}
    {controller.sessionMode && <Text>Mode: {safeText(controller.sessionMode)}</Text>}
    <Text wrap="truncate-end">Workspace: {safeText(label)}</Text>
    {metricLines(view.values, state.defaultModel, running).map((line, index) => <Text key={index} dimColor>{safeText(line)}</Text>)}
    {costs && <Text dimColor>Cost (CNY estimate): Session {sessionCost} · Today {todayCost}</Text>}
    {costs && coverage === 'partial' && <Text color={theme.colors.context}>Cost coverage incomplete: {costs.error ? safeText(costs.error) : 'no complete scan yet'}</Text>}
    <Text dimColor>Turns: {count(numeric(record(view.values.sessionStats).turns))}</Text>
    <Text dimColor>Queued: {count(view.queued)} · Active jobs: {count(view.jobs)}</Text>
    {state.controlError && <Text color={theme.colors.context}>{safeText(state.controlError)}</Text>}
    {state.presetError && <Text color={theme.colors.context}>Preset names unavailable: {safeText(state.presetError)}</Text>}
    {state.modelError && <Text color={theme.colors.context}>Model catalog unavailable: {safeText(state.modelError)}</Text>}
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
