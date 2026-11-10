/** SGR mouse reporting, shared by transcript scrolling, row clicks and input suppression. */
import { useEffect, useRef } from 'react';
import { useStdin, useStdout } from 'ink';
import stringWidth from 'string-width';

/** Recognize complete SGR reports so clicks and wheel bytes never become prompt text.
 * @param raw - One Ink input-parser event.
 * @returns Whether this is a mouse report, including non-wheel buttons.
 */
export function isMouseReport(raw: string): boolean { return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(raw); }

/** Decode vertical wheel presses, ignoring releases, motion and horizontal wheels.
 * @param raw - One complete SGR mouse report.
 * @returns Positive for older history, negative for newer history, or zero.
 */
export function wheelDirection(raw: string): number {
  const match = /^\x1b\[<(\d+);\d+;\d+M$/.exec(raw);
  if (!match) return 0;
  const button = Number(match[1]);
  const base = button & ~28;
  return base === 64 ? 1 : base === 65 ? -1 : 0;
}

/** One unmodified left press, in the terminal's own 1-based cells. */
export interface MousePress { column: number; row: number }

/** Count complete, nonblank graphemes between two cells, excluding viewport padding. */
export function draggedCharacters(rows: readonly string[], top: number, start: MousePress, end: MousePress): number {
  const [first, last] = start.row < end.row || start.row === end.row && start.column <= end.column
    ? [start, end] : [end, start];
  let count = 0;
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (let index = 0; index < rows.length; index++) {
    const row = top + index + 1;
    if (row < first.row || row > last.row) continue;
    const left = row === first.row ? first.column : 2;
    const right = row === last.row ? last.column : Infinity;
    let column = 2; // App's one-cell horizontal padding; terminal coordinates are 1-based.
    for (const { segment } of segments.segment(rows[index]!)) {
      const width = stringWidth(segment);
      if (column >= left && column + width <= right && /\S/u.test(segment)) count++;
      column += width;
    }
  }
  return count;
}

/** Decode an unmodified left press; releases, motion and modified presses are ignored.
 * @param raw - One complete SGR mouse report.
 * @returns The pressed cell, or undefined.
 */
export function mousePress(raw: string): MousePress | undefined {
  const match = /^\x1b\[<0;(\d+);(\d+)M$/.exec(raw);
  if (!match) return undefined;
  return { column: Number(match[1]), row: Number(match[2]) };
}

/** Enable cell-based mouse reports for this mount and restore normal terminal behavior on exit.
 * @param scroll - Current transcript scrolling callback.
 * @param enabled - False restores native terminal selection while display updates are paused.
 * @param press - Left-press callback; return true to allow a drag from this cell.
 * @param drag - Left-button motion callback for an accepted press.
 */
export function useMouseWheel(scroll: (direction: number) => void, enabled = true,
  press?: (cell: MousePress) => boolean | void, drag?: (start: MousePress, end: MousePress) => void): void {
  const { internal_eventEmitter } = useStdin();
  const { stdout } = useStdout();
  const callback = useRef(scroll);
  callback.current = scroll;
  const onPress = useRef(press);
  onPress.current = press;
  const onDrag = useRef(drag);
  onDrag.current = drag;
  useEffect(() => {
    if (!enabled) return;
    let anchor: MousePress | undefined;
    const onInput = (raw: string) => {
      const direction = wheelDirection(raw);
      if (direction) { anchor = undefined; callback.current(direction); }
      else {
        const cell = mousePress(raw);
        if (cell !== undefined) anchor = onPress.current?.(cell) === true ? cell : undefined;
        else {
          const motion = /^\x1b\[<32;(\d+);(\d+)M$/.exec(raw);
          if (motion && anchor) onDrag.current?.(anchor, { column: Number(motion[1]), row: Number(motion[2]) });
          else anchor = undefined;
        }
      }
    };
    internal_eventEmitter.on('input', onInput);
    if (stdout.isTTY) stdout.write('\x1b[?1006h\x1b[?1000h\x1b[?1002h');
    return () => {
      internal_eventEmitter.removeListener('input', onInput);
      if (stdout.isTTY) stdout.write('\x1b[?1002l\x1b[?1000l\x1b[?1006l');
    };
  }, [internal_eventEmitter, stdout, enabled]);
}
