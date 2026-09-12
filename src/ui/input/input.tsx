/** Terminal editing with explicit cursor ownership, Unicode movement and a bounded multi-row window. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { isMouseReport } from './mouse.ts';
import { cursorPlace, foldLabel, planDraft, windowRows, type FoldRegion } from './viewport.ts';
import { Box, Text, useInput, useStdin, type Key } from 'ink';

/** Editor offsets are UTF-16 positions at grapheme boundaries; killed text stays local. */
export interface EditState { text: string; cursor: number; killed: string }

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A cursor position strictly inside a folded block is pulled to the nearer edge, so movement
 * never parks inside a block that renders as one summary row. */
function snap(position: number, regions: readonly FoldRegion[], direction: -1 | 1): number {
  for (const region of regions) {
    if (position > region.start && position < region.end) return direction < 0 ? region.start : region.end;
  }
  return position;
}

/** Apply one Ink-decoded terminal key; application commands remain owned by the parent.
 * @param state - Current text, cursor, and most recently killed text.
 * @param input - Decoded text or control-key letter.
 * @param key - Ink's VT/terminal key flags.
 * @param regions - Source ranges rendered as a single folded row.
 * @returns The next editor state, without sending a message or exiting.
 */
export function editInput(state: EditState, input: string, key: Partial<Key>, regions: readonly FoldRegion[] = []): EditState {
  const { text, cursor, killed } = state;
  if (key.eventType === 'release' || key.return || key.tab || key.escape || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return state;
  const previous = () => snap(segments.segment(text).containing(cursor - 1)?.index ?? 0, regions, -1);
  const next = () => {
    const part = segments.segment(text).containing(cursor);
    return snap(part ? part.index + part.segment.length : text.length, regions, 1);
  };
  const wordStart = () => snap(text.slice(0, cursor).replace(/\s+$/u, '').replace(/\S+$/u, '').length, regions, -1);
  const wordEnd = () => snap(cursor + (/^\s*\S+/u.exec(text.slice(cursor))?.[0].length ?? text.length - cursor), regions, 1);
  const move = (position: number) => position === cursor ? state : ({ ...state, cursor: position });
  const remove = (start: number, end: number, kill = false): EditState => ({
    text: text.slice(0, start) + text.slice(end), cursor: start,
    killed: kill && start !== end ? text.slice(start, end) : killed,
  });
  // A folded block is one object: crossing it is one step, and backspace or delete at its edge
  // removes the whole block rather than one character of hidden text.
  const trailingFold = regions.find(region => region.end === cursor);
  const leadingFold = regions.find(region => region.start === cursor);
  if (key.home || key.ctrl && input === 'a') return move(0);
  if (key.end || key.ctrl && input === 'e') return move(text.length);
  if (key.meta && input === 'b' || key.ctrl && key.leftArrow) return move(wordStart());
  if (key.meta && input === 'f' || key.ctrl && key.rightArrow) return move(wordEnd());
  if (key.leftArrow || key.ctrl && input === 'b') return move(previous());
  if (key.rightArrow || key.ctrl && input === 'f') return move(next());
  if (key.ctrl && input === 'k') return remove(cursor, text.length, true);
  if (key.ctrl && input === 'u') return remove(0, cursor, true);
  if (key.ctrl && input === 'w' || key.meta && key.backspace) return remove(wordStart(), cursor, true);
  if (key.meta && input === 'd') return remove(cursor, wordEnd(), true);
  if (key.backspace || key.ctrl && input === 'h') return trailingFold ? remove(trailingFold.start, trailingFold.end) : remove(previous(), cursor);
  if (key.delete || key.ctrl && input === 'd') return leadingFold ? remove(leadingFold.start, leadingFold.end) : remove(cursor, next());
  if (key.ctrl && input === 'y') return { ...state, text: text.slice(0, cursor) + killed + text.slice(cursor), cursor: cursor + killed.length };
  if (key.ctrl || key.meta || key.super || key.hyper) return state;
  // A paste keeps its line breaks and tabs; the display row is where they are turned into layout.
  const inserted = input.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  if (!inserted) return state;
  return { ...state, text: text.slice(0, cursor) + inserted + text.slice(cursor), cursor: cursor + inserted.length };
}

/** Controlled composer with local cursor, kill buffer and a cursor-following row window.
 *
 * Enter submission belongs to the caller. A draft taller than `maxRows` scrolls inside the composer
 * so the conversation above it keeps its space; a multiline block taller than the window folds to a
 * single summary row whose text is still sent in full.
 */
export function TextInput({ value, onChange, onCursorChange, onSubmit, focus, placeholder, reservedKeys, width, maxRows, prompt = '❯ ', promptColor }: {
  value: string; onChange(value: string): void; onCursorChange(cursor: number): void;
  onSubmit(): void; focus: boolean; placeholder: string;
  /** Keys owned by the surrounding picker while the composer is empty. */
  reservedKeys?: readonly string[];
  /** Cells available to the draft, excluding the prompt and the composer border. */
  width: number;
  /** Content rows shown before the composer scrolls. */
  maxRows: number;
  /** Prompt drawn on the first visible row. */
  prompt?: string;
  /** Prompt colour, which dims while an answer dialog parks the draft. */
  promptColor?: string;
}) {
  const { internal_eventEmitter } = useStdin();
  const rawKey = useRef('');
  useEffect(() => {
    // Ink 6 merges DEL (backspace) and CSI 3~ (forward delete) into key.delete.
    // Capture the same decoded input event before useInput discards its raw bytes.
    const remember = (raw: string) => { rawKey.current = raw; };
    internal_eventEmitter.prependListener('input', remember);
    return () => { internal_eventEmitter.removeListener('input', remember); };
  }, [internal_eventEmitter]);
  const current = useRef<EditState>({ text: value, cursor: value.length, killed: '' });
  const [, redraw] = useState(0);
  if (current.current.text !== value) current.current = { ...current.current, text: value, cursor: value.length };
  const { text, cursor } = current.current;
  const plan = useMemo(() => planDraft(text, width, maxRows), [text, width, maxRows]);
  // Input callbacks run before Ink refreshes the controlled field, so the handler reads the
  // freshest regions through a ref instead of the closure it was created with.
  const regions = useRef(plan.regions); regions.current = plan.regions;
  useInput((input, key) => {
    if (key.eventType === 'release' || isMouseReport(rawKey.current)) return;
    if (!current.current.text && !key.ctrl && !key.meta && reservedKeys?.includes(input)) return;
    if (key.return) { onSubmit(); return; }
    const before = current.current;
    const backspace = rawKey.current === '\x7f' || rawKey.current === '\x1b\x7f'
      || /^\x1b\[127(?:;[\d:]+)?u$/.test(rawKey.current);
    const after = editInput(before, input, key.delete && backspace ? { ...key, delete: false, backspace: true } : key, regions.current);
    current.current = after;
    if (after.text !== before.text) onChange(after.text);
    if (after.cursor !== before.cursor || after.text !== before.text) onCursorChange(after.cursor);
    if (after.text === before.text && after.cursor !== before.cursor) redraw(value => value + 1);
  }, { isActive: focus });
  if (!text) {
    if (!focus) return <Text dimColor>{prompt}{placeholder}</Text>;
    return <Text><Text color={promptColor}>{prompt}</Text><Text inverse>{placeholder[0] ?? ' '}</Text><Text dimColor>{placeholder.slice(1)}</Text></Text>;
  }
  const place = cursorPlace(plan.rows, cursor);
  const window = windowRows(plan.rows.length, place.row, maxRows);
  return <Box flexDirection="column" flexShrink={0}>
    {plan.rows.slice(window.start, window.end).map((row, offset) => {
      const index = window.start + offset;
      const lead = index === window.start ? prompt : ' '.repeat(prompt.length);
      const key = `${row.start}:${index}`;
      if (row.fold) return <Text key={key} dimColor><Text color={promptColor}>{lead}</Text>{foldLabel(row.fold)}</Text>;
      if (index !== place.row) return <Text key={key}><Text color={promptColor}>{lead}</Text>{row.text}</Text>;
      const at = Math.min(place.index, row.text.length);
      const end = row.map[cursor - row.start + 1] ?? row.text.length;
      return <Text key={key}><Text color={promptColor}>{lead}</Text>{row.text.slice(0, at)}<Text inverse={focus}>{row.text.slice(at, end) || ' '}</Text>{row.text.slice(end)}</Text>;
    })}
  </Box>;
}
