/** Only visible semantic rows become React nodes; ANSI colors are applied after remote text sanitation. */
import { Box, Text } from 'ink';
import type { HistoryRow } from '../../session/history.ts';
import { useTheme } from '../theme/index.ts';

/** Render a viewport with role, reasoning, tool and result colors from the selected theme.
 *
 * Rows are sibling text nodes rather than lines inside one text node: Ink measures and caches text per
 * node, so a parent holding the whole viewport is re-measured and retained whenever one row changes.
 * An empty row renders as a single space because Ink gives an empty text node no height.
 * @param rows - Already wrapped, terminal-safe visible rows.
 * @returns Colored rows with unchanged row geometry and plain-text role markers.
 */
export function HistoryViewport({ rows }: { rows: HistoryRow[] }) {
  const theme = useTheme();
  return <Box flexDirection="column">{rows.map((row, index) => <Text key={index} color={theme.colors[row.kind]} bold={row.bold}>
    {row.spans?.length ? row.spans.map((span, position) => <Text key={position} bold={span.bold} italic={span.italic}
      underline={span.underline} strikethrough={span.strikethrough} inverse={span.inverse}>{span.text}</Text>)
      : row.text === '' ? ' ' : row.text}
  </Text>)}</Box>;
}
