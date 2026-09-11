/** Only visible semantic rows become React nodes; ANSI colors are applied after remote text sanitation. */
import { Text } from 'ink';
import type { HistoryRow } from '../../session/history.ts';
import { useTheme } from '../theme/index.ts';

/** Render a viewport with role, reasoning, tool and result colors from the selected theme.
 * @param rows - Already wrapped, terminal-safe visible rows.
 * @returns Colored text with unchanged row geometry and plain-text role markers.
 */
export function HistoryViewport({ rows }: { rows: HistoryRow[] }) {
  const theme = useTheme();
  return <Text>{rows.map((row, index) => <Text key={index} color={theme.colors[row.kind]} bold={row.bold}>
    {row.text}{index < rows.length - 1 ? '\n' : ''}
  </Text>)}</Text>;
}
