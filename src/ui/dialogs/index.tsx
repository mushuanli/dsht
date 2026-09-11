/** Modal panels and list screens rendered inside the shared composer frame. */
import { Box, Text } from 'ink';
import { array, object, safeText, string, type ObjectValue } from '../../transport/wire.ts';
import { toolLine, type Message } from '../../session/transcript.ts';
import type { HistorySearch, RemovalTarget } from '../../session/types.ts';
import type { QueuedInput } from '../../session/telemetry.ts';
import { COMMAND_HINTS, COMMAND_LABELS, COMMAND_LABEL_WIDTH } from '../commands/registry.ts';
import { useTheme } from '../theme/index.ts';
import { Picker, type Choice } from './picker.tsx';

/** Pending host input with explicit removal.
 * @param props - Queue contents, geometry and availability.
 * @returns The pending-input picker.
 */
export function QueueDialog({ queued, rows, width, unavailable, enabled, canSelect, onRemove }: {
  queued: readonly QueuedInput[]; rows: number; width: number; unavailable: boolean;
  enabled: boolean; canSelect(): boolean; onRemove(id: string): void;
}) {
  return <Box flexDirection="column">
    <Text bold>Pending input · Esc close</Text>
    {!queued.length && <Text dimColor>{unavailable ? 'Host queue unavailable' : 'No pending input'}</Text>}
    <Picker choices={queued.map(item => ({
      key: item.id, label: toolLine(item.text, width - 6),
      action: () => onRemove(item.id),
      remove: () => onRemove(item.id),
    }))} pageSize={Math.max(1, Math.min(6, rows - 12))}
      hint="↑ ↓ select · Enter / d / Delete remove · Esc close"
      enabled={enabled} canSelect={canSelect} />
  </Box>;
}

/** Confirmation for workspace removal or session archival.
 * @param props - Reviewed target and its confirmation actions.
 * @returns The confirmation dialog.
 */
export function RemovalDialog({ removal, enabled, canSelect, onCancel, onConfirm }: {
  removal: RemovalTarget; enabled: boolean; canSelect(): boolean; onCancel(): void; onConfirm(): void;
}) {
  const theme = useTheme();
  return <Box flexDirection="column" marginY={1}>
    <Text bold color={theme.colors.context}>{removal.kind === 'workspace' ? 'Remove workspace registration?' : 'Archive session?'}</Text>
    <Text wrap="truncate-end">{safeText(removal.name)}</Text>
    <Text wrap="truncate-end">ID: {safeText(removal.id)}</Text>
    {removal.path && <Text wrap="truncate-end">Path: {safeText(removal.path)}</Text>}
    <Text>{removal.kind === 'workspace' ? 'Removes the workspace from the list. Directory and sessions are kept.' : 'Hides the session from lists. History is kept; /resume ID can reopen it.'}</Text>
    <Text dimColor>Running tasks continue. Esc cancels this dialog.</Text>
    <Picker key={`${removal.kind}:${removal.id}`} choices={[
      { key: 'cancel', label: 'Cancel', action: onCancel },
      { key: 'confirm', label: removal.kind === 'workspace' ? 'Remove workspace' : 'Archive session', action: onConfirm },
    ]} enabled={enabled} canSelect={canSelect} />
  </Box>;
}

/** Two-step model and reasoning-effort selector. */
export interface ModelState { catalog: ObjectValue; provider?: string; model?: ObjectValue }

/** Model routes and adapter-owned reasoning efforts.
 * @param props - Catalog, current step and its selection actions.
 * @returns The model or effort picker.
 */
export function ModelDialog({ models, rows, width, enabled, canSelect, onChoose, onOpen, onBack, onClose }: {
  models: ModelState; rows: number; width: number; enabled: boolean; canSelect(): boolean;
  onChoose(provider: string, model: string, effort?: string): void;
  onOpen(provider: string, model: ObjectValue): void;
  onBack(): void; onClose(): void;
}) {
  const theme = useTheme();
  return <Box flexDirection="column" marginY={1}>
    <Text bold>{models.model ? 'Choose reasoning effort' : 'Choose model'}</Text>
    <Text dimColor>Applies to subsequent requests; host also saves the default.</Text>
    {array(models.catalog.failures).map(object).map(failure => <Text key={string(failure.id)} color={theme.colors.error}>{safeText(`${failure.name}: ${failure.message}`)}</Text>)}
    <Picker key={models.model ? `${models.provider}:${models.model.id}` : 'models'} pageSize={Math.max(1, Math.min(8, rows - 15))}
      choices={models.model ? [
        { key: 'default', label: `Default effort${object(models.model.reasoning).defaultEffort ? ` · ${string(object(models.model.reasoning).defaultEffort)}` : ''}`,
          action: () => onChoose(models.provider!, string(models.model!.id)) },
        ...array(object(models.model.reasoning).efforts).map(object).map(effort => ({ key: string(effort.id), label: toolLine(`${effort.name} (${effort.id})${effort.description ? ` · ${effort.description}` : ''}`, width - 2),
          action: () => onChoose(models.provider!, string(models.model!.id), string(effort.id)) })),
        { key: 'back', label: '← Models', action: onBack },
      ] : [
        ...array(models.catalog.groups).map(object).flatMap(group => array(group.models).map(object).map(model => ({
          key: `${group.id}:${model.id}`, label: toolLine(`${group.name} · ${model.name} (${model.id})`, width - 2),
          action: () => { if (array(object(model.reasoning ?? { efforts: [] }).efforts).length) onOpen(string(group.id), model);
            else onChoose(string(group.id), string(model.id)); },
        }))),
        { key: 'close', label: '← Back to conversation', action: onClose },
      ]} enabled={enabled} canSelect={canSelect} />
  </Box>;
}

/** Bounded host session-search results.
 * @param props - Query, results and their opening action.
 * @returns The session-search picker.
 */
export function SearchResultsDialog({ query, items, hasMore, width, enabled, canSelect, onOpen, onClose }: {
  query: string; items: readonly ObjectValue[]; hasMore: boolean; width: number;
  enabled: boolean; canSelect(): boolean; onOpen(sessionId: string): void; onClose(): void;
}) {
  const theme = useTheme();
  return <Box flexDirection="column" marginY={1}>
    <Text bold>Session search · {safeText(query)}</Text>
    {hasMore && <Text color={theme.colors.context}>Host returned only the first 20 global matches; workspace results may be incomplete. Refine your query.</Text>}
    {!items.length && <Text>No sessions in the returned results</Text>}
    <Picker choices={[...items.map(item => ({ key: string(item.sessionId),
      label: toolLine(`${item.sessionId} · ${item.snippet}`, width - 2),
      action: () => onOpen(string(item.sessionId)) })), { key: 'close', label: '← Back', action: onClose }]}
      enabled={enabled} canSelect={canSelect} />
  </Box>;
}

/** Title, current selection and confirm action for a picker screen.
 * @param props - Screen title, list identity and navigation state.
 * @returns The picker screen.
 */
export function PickerScreen({ title, identity, choices, enabled, canSelect }: {
  title: string; identity: string; choices: Choice[]; enabled: boolean; canSelect(): boolean;
}) {
  return <Box flexDirection="column" marginY={1}>
    <Text bold>{title}</Text>
    <Picker key={identity} choices={choices} enabled={enabled} canSelect={canSelect} />
  </Box>;
}

/** Newest-first reasoning summaries with the preceding user prompt.
 * @param props - Loaded entries and lazy paging action.
 * @returns The reasoning list.
 */
export function ThoughtsDialog({ identity, options, empty, rows, enabled, canSelect }: {
  identity: string; options: Choice[]; empty: boolean; rows: number; enabled: boolean; canSelect(): boolean;
}) {
  const theme = useTheme();
  return <Box flexDirection="column" marginY={1}>
    <Text bold color={theme.colors.reasoning}>Reasoning history · User prompts · Esc close</Text>
    {empty && <Text dimColor>No reasoning in loaded history</Text>}
    <Picker key={identity} choices={options} pageSize={Math.max(1, Math.min(6, Math.floor((rows - 14) / 2)))} enabled={enabled} canSelect={canSelect} />
  </Box>;
}

/** Loaded prompts or bounded content matches with a jump action.
 * @param props - Query mode, matches and the selected record.
 * @returns The history or search picker.
 */
export function HistoryDialog({ identity, contentSearch, matches, query, messages, width, enabled, canSelect, onJump, onClose }: {
  identity: string; contentSearch: boolean; matches?: HistorySearch; query: string; messages: readonly Message[];
  width: number; enabled: boolean; canSelect(): boolean; onJump(seq: number): void; onClose(): void;
}) {
  const theme = useTheme();
  const needle = query.toLowerCase();
  return <Box flexDirection="column" marginY={1}>
    <Text bold>{contentSearch ? 'Search · session history' : 'History · loaded records'} · Esc close</Text>
    {contentSearch && matches?.truncated && <Text color={theme.colors.context}>Showing the first 200 matches · Refine your search</Text>}
    <Picker key={identity} choices={[
      ...(contentSearch && matches ? matches.items.map(message => ({
        key: String(message.seq), label: toolLine(`#${message.seq} ${message.role} · ${message.preview}`, width - 2),
        action: () => onJump(message.seq),
      })) : messages.filter(message => message.role === 'You' && `${message.seq} ${message.text}`.toLowerCase().includes(needle)).map(message => ({
        key: String(message.seq), label: toolLine(`#${message.seq} ${message.role} · ${message.text}`, width - 2),
        action: () => onJump(message.seq),
      }))),
      { key: 'close', label: '← Back to conversation', action: onClose },
    ]} enabled={enabled} canSelect={canSelect} />
  </Box>;
}

/** Paged slash-command reference.
 * @param props - Current page, page count and rows per page.
 * @returns The help panel.
 */
export function HelpPanel({ page, pages, pageSize }: { page: number; pages: number; pageSize: number }) {
  const theme = useTheme();
  return <Box flexDirection="column" flexShrink={1} minHeight={0} overflowY="hidden">
    {COMMAND_HINTS.slice(page * pageSize, (page + 1) * pageSize).map((hint, index) => <Text key={hint.command} dimColor wrap="truncate-end">
      <Text color={theme.accent}>{COMMAND_LABELS[page * pageSize + index]!.padEnd(COMMAND_LABEL_WIDTH)}</Text>{hint.description}
    </Text>)}
    <Text dimColor>Help {page + 1}/{pages} · PgUp/PgDn pages · Esc close</Text>
    <Text dimColor>Enter send · Tab complete · Esc cancel · Wheel/PgUp/PgDn scroll · Ctrl+C clear / stop / exit</Text>
    <Text dimColor>History: ↑/↓ or Ctrl+P/N recall · Editing: Ctrl+A/E start/end · Ctrl+K/U kill right/left · Ctrl+W kill word · Ctrl+Y restore</Text>
  </Box>;
}

/** Compact preview of host-owned pending input above the composer.
 * @param props - Pending items and available columns.
 * @returns Up to two pending-input rows.
 */
export function QueuedPreview({ queued, width }: { queued: readonly QueuedInput[]; width: number }) {
  return <Box flexDirection="column" flexShrink={0}>
    <Text dimColor>Waiting: {queued.length} · /queue to remove</Text>
    {queued.slice(0, 2).map(item => <Text key={item.id} dimColor wrap="truncate-end">{item.placement === 'steering' ? '↳ ' : '· '}{safeText(toolLine(item.text, width - 6))}</Text>)}
  </Box>;
}
