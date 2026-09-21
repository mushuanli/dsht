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
  // A paused run is waiting for the operator, not finished: the line says what to do about it.
  const paused = progress.active && progress.phase === 'needs-human';
  // A run stopped on a host request shows what the host is waiting for, not just the phase name.
  const interaction = progress.interaction === undefined ? '' : ` · ${progress.interaction.kind}: ${progress.interaction.text}`;
  // A run a verifier ended early says why: the reason is the only part of that verdict a reader acts on.
  const exit = progress.exit === undefined ? '' : ` · ${progress.exit.reason}`;
  // `passed` only claims the rounds that ran, so the line says which ones it covered.
  const scope = progress.phase === 'passed' ? ` · ${progress.scope}` : '';
  // What the live run waits on is controller data, not a note: a work turn is already visible as the
  // session working, so only the states without a host turn of their own are named here.
  const activity = running && progress.activity !== undefined && progress.activity !== 'turn'
    ? ` · ${progress.activity}` : '';
  return <Text color={progress.active ? theme.colors.context : theme.colors.muted}>
    {progress.title}{progress.stepLabel === undefined ? '' : ` · ${progress.stepLabel}`} · step {progress.step}/{progress.to} · attempt {progress.attempt}/{progress.tries} · best {progress.best}/{progress.score}{running ? '' : paused ? ' · needs you · /loop answer' : ` · ${progress.phase}`}{activity}{scope}{exit}{interaction}{progress.note === undefined ? '' : ` · ${progress.note}`}
  </Text>;
}
