/** SGR mouse reporting, shared by transcript scrolling and input suppression. */
import { useEffect, useRef } from 'react';
import { useStdin, useStdout } from 'ink';

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

/** Enable cell-based mouse reports for this mount and restore normal terminal behavior on exit.
 * @param scroll - Current transcript scrolling callback.
 * @param enabled - False restores native terminal selection while display updates are paused.
 * @param select - Left press callback that can freeze the display and release mouse capture.
 */
export function useMouseWheel(scroll: (direction: number) => void, enabled = true, select?: () => void): void {
  const { internal_eventEmitter } = useStdin();
  const { stdout } = useStdout();
  const callback = useRef(scroll);
  callback.current = scroll;
  const selection = useRef(select);
  selection.current = select;
  useEffect(() => {
    if (!enabled) return;
    const onInput = (raw: string) => {
      const direction = wheelDirection(raw);
      if (direction) callback.current(direction);
      else if (/^\x1b\[<0;\d+;\d+M$/.test(raw)) selection.current?.();
    };
    internal_eventEmitter.on('input', onInput);
    if (stdout.isTTY) stdout.write('\x1b[?1006h\x1b[?1000h');
    return () => {
      internal_eventEmitter.removeListener('input', onInput);
      if (stdout.isTTY) stdout.write('\x1b[?1000l\x1b[?1006l');
    };
  }, [internal_eventEmitter, stdout, enabled]);
}
