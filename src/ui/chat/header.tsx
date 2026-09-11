/** Fixed conversation header: session title, workspace, and the agent-preset label. */
import { Box, Text } from 'ink';
import { toolLine } from '../../session/transcript.ts';
import { Frozen } from '../frozen.tsx';
import { useTheme } from '../theme/index.ts';

/** Session title and optional preset label above the divider.
 * @param props - Title, preset label, geometry and freeze identity.
 * @returns The header rows.
 */
export function ChatHeader({ title, mode, width, frozen, identity }: {
  title: string; mode?: string; width: number; frozen: boolean; identity: string;
}) {
  const theme = useTheme();
  return <Frozen frozen={frozen} identity={identity}><Box flexDirection="column" flexShrink={0}>
    <Box width={width}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}><Text bold color={theme.accent} wrap="truncate-end">{toolLine(title, width)}</Text></Box>
      {width >= 60 && mode && <Box flexShrink={0} marginLeft={2}><Text color={theme.accent}>{toolLine(mode, Math.min(24, Math.floor(width / 3)))}</Text></Box>}
    </Box>
    <Text dimColor>{'─'.repeat(width)}</Text>
  </Box></Frozen>;
}
