/** Measured conversation viewport: only visible rows become React nodes. */
import { Box, Text, type DOMElement } from 'ink';
import type { RefObject } from 'react';
import type { HistoryRow } from '../../session/history.ts';
import { Frozen } from '../frozen.tsx';
import { useTheme } from '../theme/index.ts';
import { HistoryViewport } from './history-view.tsx';

/** Visible conversation rows plus the scroll hint.
 * @param props - Rows, hint state, freeze identity and the measured box.
 * @returns The scrollable conversation area.
 */
export function ChatViewport({ rows, showHistoryHint, dialogOpen, historyWindow, frozen, identity, boxRef }: {
  rows: HistoryRow[]; showHistoryHint: boolean; dialogOpen: boolean; historyWindow: boolean;
  frozen: boolean; identity: string; boxRef: RefObject<DOMElement | null>;
}) {
  const theme = useTheme();
  return <Box ref={boxRef} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden" marginY={dialogOpen ? 0 : 1}>
    {rows.length ? <Frozen frozen={frozen} identity={identity}><HistoryViewport rows={rows} /></Frozen> : <Text color={theme.colors.muted}>Start a conversation with the host agent.</Text>}
    {showHistoryHint && <Text dimColor wrap="truncate-end">{dialogOpen ? 'Wheel/PgUp/PgDn · Scroll history' : historyWindow ? 'Earlier history · /latest returns to live conversation' : 'Scroll up or /older to load earlier history'}</Text>}
  </Box>;
}
