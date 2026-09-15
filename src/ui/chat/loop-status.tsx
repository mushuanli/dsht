/** One-line progress of a client-driven agent loop, for whichever protocol is running. */
import { Text } from 'ink';
import type { LoopProgress } from '../../contracts.ts';
import { useTheme } from '../theme/index.ts';

/** Progress line shown above the composer.
 *
 * It names no command: the protocol supplies `title`, and the remaining fields are the generic
 * step/attempt score shape, so a new loop protocol renders here without a UI change.
 * @param props - The application-produced loop snapshot.
 * @returns One dim line, brightened while the loop is still running.
 */
export function LoopStatus({ progress }: { progress: LoopProgress }) {
  const theme = useTheme();
  const running = progress.phase === 'running';
  return <Text color={running ? theme.colors.context : theme.colors.muted}>
    {progress.title} · step {progress.step}/{progress.to} · attempt {progress.attempt}/{progress.tries} · best {progress.best}/{progress.score}{running ? '' : ` · ${progress.phase}`}
  </Text>;
}
