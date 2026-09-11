/** Shared list selector used by every picker and dialog. */
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { safeText } from '../../transport/wire.ts';
import { useCopyMode } from '../copy-mode.ts';
import { useTheme } from '../theme/index.ts';

/** One selectable row; a `remove` action adds the archive/delete affordance. */
export interface Choice { key: string; label: string; action(): void; remove?(): void }

/** Keyboard-driven list with paging and optional removal.
 * @param props - Choices, availability, page size and hint text.
 * @returns The rendered list rows and its navigation hint.
 */
export function Picker({ choices, enabled, canSelect, pageSize = 12, hint }: { choices: Choice[]; enabled: boolean; canSelect(): boolean; pageSize?: number; hint?: string }) {
  const theme = useTheme();
  const copyMode = useCopyMode();
  const [selected, setSelected] = useState(0);
  const current = Math.min(selected, choices.length - 1);
  const { internal_eventEmitter } = useStdin();
  const rawKey = useRef('');
  useEffect(() => {
    const remember = (raw: string) => { rawKey.current = raw; };
    internal_eventEmitter.prependListener('input', remember);
    return () => { internal_eventEmitter.removeListener('input', remember); };
  }, [internal_eventEmitter]);
  useInput((_input, key) => {
    if (!canSelect() || key.eventType === 'release') return;
    if (key.upArrow) setSelected(Math.max(0, current - 1));
    else if (key.downArrow) setSelected(Math.min(choices.length - 1, current + 1));
    else if (_input === 'd' && !key.ctrl && !key.meta || key.delete && /^\x1b\[3(?:;\d+)?~$/.test(rawKey.current)) choices[current]?.remove?.();
    else if (key.return) choices[current]?.action();
  }, { isActive: enabled && !copyMode });
  const start = Math.max(0, current - Math.max(0, pageSize - 1));
  return <Box flexDirection="column">
    {choices.slice(start, start + pageSize).map((choice, index) => <Text key={choice.key}
      color={start + index === current ? theme.accent : undefined}>
      {start + index === current ? '❯ ' : '  '}{safeText(choice.label)}
    </Text>)}
    <Text dimColor>{hint ?? `↑ ↓ select · Enter open${choices.some(choice => choice.remove) ? ' · d/Delete remove / archive' : ''} · Ctrl+C stop / exit`}</Text>
  </Box>;
}
