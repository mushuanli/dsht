/** Measured conversation viewport: only visible rows become React nodes. */
import { Box, Text, type DOMElement } from 'ink';
import type { RefObject } from 'react';
import type { HistoryRow } from '../../contracts.ts';
import { Frozen } from '../frozen.tsx';
import { useTheme } from '../theme/index.ts';
import { HistoryViewport } from './history-view.tsx';

/** Visible conversation rows plus the scroll hint.
 * @param props - Rows, the hint the caller wrote, freeze identity and the measured box.
 * @returns The scrollable conversation area.
 */
export function ChatViewport({ rows, hint, dialogOpen, frozen, identity, boxRef }: {
  rows: HistoryRow[]; hint?: string; dialogOpen: boolean;
  frozen: boolean; identity: string; boxRef: RefObject<DOMElement | null>;
}) {
  const theme = useTheme();
  return <Box ref={boxRef} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden" marginY={dialogOpen ? 0 : 1}>
    {rows.length ? <Frozen frozen={frozen} identity={identity}><HistoryViewport rows={rows} /></Frozen> : <Text color={theme.colors.muted}>Start a conversation with the host agent.</Text>}
    {hint !== undefined && <Box flexGrow={1} flexShrink={0} minHeight={1} alignItems="flex-end"><Text dimColor wrap="truncate-end">{hint}</Text></Box>}
  </Box>;
}
