/** Shared list selector used by every picker and dialog. */
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin, useStdout } from 'ink';
import stringWidth from 'string-width';
import { safeText } from '../../transport/wire.ts';
import { useCopyMode } from '../copy-mode.ts';
import { useTheme } from '../theme/index.ts';

/** One cell of a table row, optionally coloured by the state it reports. */
export interface ChoiceCell { text: string; color?: string; bold?: boolean }

/** One selectable row; a `remove` action adds the archive/delete affordance.
 *
 * A row with `title`/`cells`/`detail` is laid out as a table so the state and path columns line up
 * across rows; a row with only `label` keeps the plain single-text form every dialog uses.
 */
export interface Choice {
  key: string;
  label: string;
  /** Leading table column; the row falls back to `label` when this is absent. */
  title?: string;
  /** Cells after the title, each carrying its own colour. */
  cells?: readonly ChoiceCell[];
  /** Trailing column, right-aligned and truncated from its start so a path keeps its tail. */
  detail?: string;
  action(): void;
  remove?(): void;
}

/** Display width of one cell list, so wide characters count as two columns. */
function cellsWidth(cells: readonly ChoiceCell[] | undefined): number {
  return (cells ?? []).reduce((sum, cell) => sum + stringWidth(cell.text), 0);
}

/** Keyboard-driven list with paging and optional removal.
 * @param props - Choices, availability, page size, hint text and the usable column count.
 * @returns The rendered list rows and its navigation hint.
 */
export function Picker({ choices, enabled, canSelect, pageSize = 12, hint, width }: {
  choices: Choice[]; enabled: boolean; canSelect(): boolean; pageSize?: number; hint?: string;
  /** Columns this list may occupy inside its frame; defaults to the composer's inner width. */
  width?: number;
}) {
  const theme = useTheme();
  const copyMode = useCopyMode();
  const { internal_eventEmitter } = useStdin();
  const { stdout } = useStdout();
  const [selected, setSelected] = useState(0);
  const current = Math.min(selected, choices.length - 1);
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
  const rows = choices.slice(start, start + pageSize);
  // The picker sits inside the composer frame, whose border and padding take six columns that Ink
  // never gives to the content, so a row measured against the terminal width would still wrap.
  const columns = width ?? Math.max(16, (stdout.columns ?? 80) - 6);
  // Only a row carrying a table column is measured: an entry such as `+ Add workspace` keeps the
  // plain full-width form and must not widen the columns the workspace rows share.
  const tableRows = rows.filter(choice => choice.title !== undefined || choice.cells !== undefined || choice.detail !== undefined);
  const table = tableRows.length > 0;
  // Two columns go to the cursor and two separate the title from the cells that follow it. A trailing
  // path column keeps a readable minimum, so the title yields to it rather than pushing it off screen;
  // when no row has a path, the title column may use everything the cells do not need.
  const wantsDetail = tableRows.some(choice => choice.detail !== undefined);
  const titleWidth = 4 + Math.max(0, ...tableRows.map(choice => stringWidth(choice.title ?? choice.label)));
  const cellWidth = Math.max(0, ...tableRows.map(choice => cellsWidth(choice.cells)));
  const available = Math.max(0, columns - (wantsDetail ? 12 : 0));
  const titleColumn = table ? Math.min(titleWidth, Math.max(Math.min(available, 8), available - cellWidth)) : 0;
  const cellColumn = table ? Math.min(cellWidth, Math.max(0, available - titleColumn)) : 0;
  const detailColumn = table ? Math.max(0, columns - titleColumn - cellColumn) : 0;
  const detailShown = detailColumn >= 8 && wantsDetail;
  return <Box flexDirection="column">
    {rows.map((choice, index) => {
      const isCurrent = start + index === current;
      const cursor = isCurrent ? '❯ ' : '  ';
      const isTableRow = choice.title !== undefined || choice.cells !== undefined || choice.detail !== undefined;
      if (!table || !isTableRow) return <Text key={choice.key} color={isCurrent ? theme.accent : undefined} wrap="truncate-end">
        {cursor}{safeText(choice.label)}
      </Text>;
      return <Box key={choice.key} flexDirection="row">
        <Box width={titleColumn} flexShrink={0}>
          <Text color={isCurrent ? theme.accent : undefined} wrap="truncate-end">{cursor}{safeText(choice.title ?? choice.label)}</Text>
        </Box>
        <Box width={cellColumn} flexShrink={0}>
          <Text wrap="truncate-end">{choice.cells?.map((cell, position) => <Text key={position}
            color={cell.color} bold={cell.bold}>{safeText(cell.text)}</Text>)}</Text>
        </Box>
        {detailShown && choice.detail !== undefined && <Box width={detailColumn} flexShrink={0} justifyContent="flex-end">
          <Text dimColor wrap="truncate-start">{safeText(choice.detail)}</Text>
        </Box>}
      </Box>;
    })}
    <Text dimColor>{hint ?? `↑ ↓ select · Enter open${choices.some(choice => choice.remove) ? ' · d/Delete remove / archive' : ''} · Ctrl+C stop / exit`}</Text>
  </Box>;
}
