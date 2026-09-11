/** Trailing `@` host-path completion menu. */
import { Box, Text } from 'ink';
import type { FileReference } from '../../session/references.ts';
import { useTheme } from '../theme/index.ts';

/** Candidates for the unfinished reference at the end of the draft.
 * @param props - Lookup result and the highlighted candidate.
 * @returns The completion menu.
 */
export function ReferenceMenu({ matches, index }: {
  matches?: { items: FileReference[]; error?: string }; index: number;
}) {
  const theme = useTheme();
  const start = Math.max(0, index - 5);
  return <Box flexDirection="column">
    <Text dimColor>Host files · ↑ ↓ select · Tab/Enter insert · Esc close</Text>
    {!matches ? <Text dimColor>Searching…</Text> : matches.error ? <Text color={theme.colors.error}>{matches.error}</Text>
      : matches.items.length === 0 ? <Text dimColor>No matching host files</Text>
      : matches.items.slice(start, start + 6).map((item, offset) =>
        <Text key={`${item.kind}:${item.path}`} color={offset + start === index ? theme.accent : undefined}>
          {offset + start === index ? '❯ ' : '  '}{item.path}{item.kind === 'directory' ? '/' : ''}
        </Text>)}
  </Box>;
}
