/** Single-line terminal editing with explicit cursor ownership and Unicode grapheme movement. */
import { useEffect, useRef, useState } from 'react';
import { isMouseReport } from './mouse.ts';
import { Text, useInput, useStdin, type Key } from 'ink';

/** Editor offsets are UTF-16 positions at grapheme boundaries; killed text stays local. */
export interface EditState { text: string; cursor: number; killed: string }

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Apply one Ink-decoded terminal key; application commands remain owned by the parent.
 * @param state - Current text, cursor, and most recently killed text.
 * @param input - Decoded text or control-key letter.
 * @param key - Ink's VT/terminal key flags.
 * @returns The next editor state, without sending a message or exiting.
 */
export function editInput(state: EditState, input: string, key: Partial<Key>): EditState {
  const { text, cursor, killed } = state;
  if (key.eventType === 'release' || key.return || key.tab || key.escape || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return state;
  const previous = () => segments.segment(text).containing(cursor - 1)?.index ?? 0;
  const next = () => {
    const part = segments.segment(text).containing(cursor);
    return part ? part.index + part.segment.length : text.length;
  };
  const wordStart = () => text.slice(0, cursor).replace(/\s+$/u, '').replace(/\S+$/u, '').length;
  const wordEnd = () => cursor + (/^\s*\S+/u.exec(text.slice(cursor))?.[0].length ?? text.length - cursor);
  const move = (position: number) => position === cursor ? state : ({ ...state, cursor: position });
  const remove = (start: number, end: number, kill = false): EditState => ({
    text: text.slice(0, start) + text.slice(end), cursor: start,
    killed: kill && start !== end ? text.slice(start, end) : killed,
  });
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
  if (key.backspace || key.ctrl && input === 'h') return remove(previous(), cursor);
  if (key.delete || key.ctrl && input === 'd') return remove(cursor, next());
  if (key.ctrl && input === 'y') return { ...state, text: text.slice(0, cursor) + killed + text.slice(cursor), cursor: cursor + killed.length };
  if (key.ctrl || key.meta || key.super || key.hyper) return state;
  const inserted = input.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  if (!inserted) return state;
  return { ...state, text: text.slice(0, cursor) + inserted + text.slice(cursor), cursor: cursor + inserted.length };
}

/** Controlled composer with local cursor and kill buffer; Enter submission belongs to the caller. */
export function TextInput({ value, onChange, onCursorChange, onSubmit, focus, placeholder }: {
  value: string; onChange(value: string): void; onCursorChange(cursor: number): void;
  onSubmit(): void; focus: boolean; placeholder: string;
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
  useInput((input, key) => {
    if (key.eventType === 'release' || isMouseReport(rawKey.current)) return;
    if (key.return) { onSubmit(); return; }
    const before = current.current;
    const backspace = rawKey.current === '\x7f' || rawKey.current === '\x1b\x7f'
      || /^\x1b\[127(?:;[\d:]+)?u$/.test(rawKey.current);
    const after = editInput(before, input, key.delete && backspace ? { ...key, delete: false, backspace: true } : key);
    current.current = after;
    if (after.text !== before.text) onChange(after.text);
    if (after.cursor !== before.cursor || after.text !== before.text) onCursorChange(after.cursor);
    if (after.text === before.text && after.cursor !== before.cursor) redraw(value => value + 1);
  }, { isActive: focus });
  const { text, cursor } = current.current;
  const character = segments.segment(text).containing(cursor)?.segment ?? ' ';
  if (!text && !focus) return <Text dimColor>{placeholder}</Text>;
  if (!text) return <Text><Text inverse>{placeholder[0] ?? ' '}</Text><Text dimColor>{placeholder.slice(1)}</Text></Text>;
  return <Text>{text.slice(0, cursor)}<Text inverse={focus}>{character}</Text>{text.slice(cursor + character.length)}</Text>;
}
