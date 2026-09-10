/** Terminal status from host projections; cumulative usage and estimated context stay distinct. */
import { memo, useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { costText } from './cost.ts';
import type { Controller } from './controller.ts';
import { safeText, type Json, type ObjectValue } from './wire.ts';

/** Format elapsed wall time, clamping clock skew instead of displaying negative durations.
 * @param milliseconds - Elapsed duration.
 * @returns Minute/second display, with hours when needed.
 */
export function elapsedTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
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
 * @param fields - Priority-ordered status fields, followed by optional details.
 * @param width - Available terminal columns.
 * @returns A terminal-safe single line, shortened by display width.
 */
export function compactStatus(fields: string[], width: number): string {
  const clean = fields.map(value => safeText(value).replace(/[\r\n\t]/g, ' '));
  const fit = (value: string, size: number) => {
    if (size < 2) return size === 1 ? '…' : '';
    const wrapped = wrapAnsi(value, size, { hard: true, wordWrap: false, trim: false });
    return wrapped.includes('\n') ? wrapAnsi(value, size - 1, { hard: true, wordWrap: false, trim: false }).split('\n')[0] + '…' : value;
  };
  const joins = (values: string[]) => values.filter(Boolean).join(' · ');
  const fits = (value: string) => !wrapAnsi(value, Math.max(1, width), { hard: true, wordWrap: false, trim: false }).includes('\n');
  if (fits(joins(clean))) return joins(clean);
  const core = clean.slice(0, 5);
  core[1] = fit(core[1] ?? '', Math.max(8, Math.min(28, Math.floor(width / 3))));
  core[2] = fit(core[2] ?? '', Math.max(6, Math.min(20, Math.floor(width / 5))));
  for (let size = Math.floor(width / 3); size >= 6 && !fits(joins(core)); size--) {
    core[1] = fit(clean[1] ?? '', size);
    core[2] = fit(clean[2] ?? '', Math.max(5, Math.floor(size * 0.6)));
  }
  const extras = clean.slice(5);
  while (extras.length && !fits(joins([...core, ...extras]))) extras.pop();
  return fit(joins([...core, ...extras]), width);
}

/** Render a live clock and selected-session metadata; the timer belongs to this mounted bar. */
export const StatusBar = memo(function StatusBar({ controller, expanded = false }: { controller: Controller; expanded?: boolean; revision?: number }) {
  const { stdout } = useStdout();
  const [now, setNow] = useState(Date.now);
  const running = controller.running;
  const since = controller.workingSince;
  useEffect(() => {
    setNow(Date.now());
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, since]);
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
    const model = typeof route.model === 'string' ? `${route.model}${typeof route.reasoningEffort === 'string' ? ` (${route.reasoningEffort})` : ''}` : 'model ?';
    const pressure = record(view.values.contextPressure);
    const used = numeric(pressure.projectedTokens) ?? numeric(pressure.pressureTokens);
    const capacity = numeric(pressure.contextWindow);
    const usage = record(view.values.tokenUsage);
    const buckets = [usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].map(numeric);
    const total = buckets.every(value => value !== undefined) ? (buckets as number[]).reduce((a, b) => a + b, 0) : undefined;
    const compactCount = (value: number | undefined) => value === undefined ? '?' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    const activity = running ? `Working ${since === undefined ? '?' : elapsedTime(now - since)}${state.transcript.activeTurnStartedAt === undefined ? '~' : ''}` : 'Idle';
    const fields = [
      `${!state.online ? 'Offline · ' : ''}${state.controlError || state.modelError || coverage === 'partial' ? '! ' : ''}${activity}`,
      model, `ws: ${workspace ? workspace.title : '—'}`,
      `ctx: ${used !== undefined && capacity !== undefined && capacity > 0 ? `~${Math.min(100, Math.round(used / capacity * 100))}%` : '?'}`,
      `tok: ${compactCount(total)}`,
      `in/out: ${compactCount(buckets[0])}/${compactCount(buckets[1])}`,
      `cache: ${compactCount(buckets[2])}/${compactCount(buckets[3])}`,
      `q:${count(view.queued)} jobs:${count(view.jobs)}`,
      running ? 'Esc/^C stop' : '^C exit', '/status',
    ];
    const width = Math.max(1, (stdout.columns ?? 80) - 2);
    const fee = costs ? ` · S:${sessionCost} D:${todayCost}` : '';
    return <Text dimColor wrap="truncate-end">{compactStatus(fields, Math.max(1, width - fee.length))}{fee}</Text>;
  }
  return <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
    <Text color={running ? 'yellow' : 'gray'}>{running
      ? `Working ${since === undefined ? 'unknown duration' : elapsedTime(now - since)}${state.transcript.activeTurnStartedAt === undefined ? ' (observed)' : ''} · Esc / Ctrl+C stop`
      : 'Idle · Ctrl+C exit'}{!state.online ? ' · disconnected, last known status' : ''}</Text>
    {state.sessionId && <Text>Session ID: {safeText(state.sessionId)}</Text>}
    <Text wrap="truncate-end">Workspace: {safeText(label)}</Text>
    {metricLines(view.values, state.defaultModel, running).map((line, index) => <Text key={index} dimColor>{safeText(line)}</Text>)}
    {costs && <Text dimColor>Cost (CNY estimate): Session {sessionCost} · Today {todayCost}</Text>}
    {costs && coverage === 'partial' && <Text color="yellow">Cost coverage incomplete: {costs.error ? safeText(costs.error) : 'no complete scan yet'}</Text>}
    <Text dimColor>Queued: {count(view.queued)} · Active jobs: {count(view.jobs)}</Text>
    {state.controlError && <Text color="yellow">{safeText(state.controlError)}</Text>}
    {state.modelError && <Text color="yellow">Model catalog unavailable: {safeText(state.modelError)}</Text>}
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
