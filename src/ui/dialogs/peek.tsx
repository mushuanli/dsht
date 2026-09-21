/** The full-screen read-only view of one output source.
 *
 * A reader opens this to watch work that is not their conversation — a verifier's session, a subagent
 * child, a local `!` run — without selecting it. The application follows the source and hands over laid
 * out rows; this only draws them, so nothing here can write to what it is showing.
 */
import { Box, Text, type DOMElement } from 'ink';
import type { RefObject } from 'react';
import type { HistoryRow, OutputSource } from '../../contracts.ts';
import { HistoryViewport } from '../chat/history-view.tsx';
import { elapsedTime } from '../chat/status.tsx';
import { useTheme } from '../theme/index.ts';

/** One source's identity line: what it is, who made it, how it is doing. */
function metaLine(source: OutputSource, now: number): string {
  const parts: (string | undefined)[] = [
    source.detail ?? (source.kind === 'session' ? 'session' : 'local process'),
    source.state,
    source.parentSessionId === undefined ? undefined : `from ${source.parentSessionId}`,
    source.startedAt === undefined ? undefined
      : source.state === 'running' ? `started ${new Date(source.startedAt).toLocaleTimeString()}`
      : `ran ${elapsedTime((source.endedAt ?? now) - source.startedAt)}`,
  ];
  return parts.filter((part): part is string => part !== undefined).join(' · ');
}

/** Draw one read-only source: its header, its content viewport, and the scroll line.
 * @param props - The source, its already-laid-out rows and the reader's position in them.
 * @returns The panel, filling the body area it is given.
 */
export function PeekPanel({ source, error, rows, position, total, width, now, boxRef }: {
  source: OutputSource;
  error?: string;
  rows: HistoryRow[];
  /** Rows scrolled back from the newest row; 0 is the live end. */
  position: number;
  /** Rows the source has in total, so the footer can place the window. */
  total: number;
  width: number;
  now: number;
  boxRef: RefObject<DOMElement | null>;
}) {
  const theme = useTheme();
  const end = Math.max(0, total - position);
  const first = Math.max(1, end - rows.length + 1);
  return <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden" marginY={1}>
    <Text bold color={theme.accent} wrap="truncate-end">{source.label}</Text>
    <Text dimColor wrap="truncate-end">{source.id} · {metaLine(source, now)}</Text>
    {error !== undefined && <Text color={theme.colors.error} wrap="truncate-end">{error}</Text>}
    <Text dimColor>{'─'.repeat(Math.max(0, width - 4))}</Text>
    <Box ref={boxRef} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden">
      {rows.length === 0
        ? <Text color={theme.colors.muted}>{source.state === 'running' ? 'No output yet.' : 'This source has no output.'}</Text>
        : <HistoryViewport rows={rows} />}
    </Box>
    <Text dimColor wrap="truncate-end">{total === 0 ? 'Esc closes' : `Esc closes · ↑ ↓ / PgUp PgDn / wheel scroll · lines ${first}–${end} of ${total}`}</Text>
  </Box>;
}
