/**
 * Terminal focus reporting, so "only notify while the operator is elsewhere" can be the default.
 *
 * xterm's mode 1004 makes the terminal send `CSI I` when the window or pane gains focus and `CSI O`
 * when it loses it. tmux forwards both to the pane, so the answer is right for the window the client
 * actually runs in. The mode is enabled for the mount and disabled on exit: a terminal left in it would
 * keep feeding bytes to whatever ran next.
 *
 * Ink's own parser hides the ESC and reports these as the text `[I` / `[O`, so every `useInput`
 * handler that would otherwise take text has to ignore them; `isFocusReport` is the one predicate that
 * decides that, next to `isMouseReport`.
 */
import { useEffect, useRef, useState } from 'react';
import { useStdin, useStdout } from 'ink';

/** Recognize the two focus-reporting sequences.
 * @param raw - One Ink input-parser event.
 * @returns True for a focus gain or loss, which is never text.
 */
export function isFocusReport(raw: string): boolean {
  return raw === '\u001b[I' || raw === '\u001b[O';
}

/** Decode a focus report.
 * @param raw - One Ink input-parser event.
 * @returns True when focus was gained, false when it was lost, undefined for anything else.
 */
export function focusReport(raw: string): boolean | undefined {
  if (raw === '\u001b[I') return true;
  if (raw === '\u001b[O') return false;
  return undefined;
}

/** Track whether this client's pane has the terminal's focus.
 *
 * The answer starts *unknown*, which matters: tmux does not forward focus events unless
 * `set -g focus-events on` is set, and a terminal without the mode at all never answers. Treating
 * "no answer" as "focused" would make the default condition — notify only while unfocused — silently
 * never fire, so callers must read `undefined` as "not known to be focused" and stay quiet only once
 * the terminal has actually said so.
 * @param enabled - False leaves the terminal's mode alone (tests, or a caller that opted out).
 * @returns True/False once the terminal reported focus, undefined while it has not.
 */
export function useTerminalFocus(enabled = true): boolean | undefined {
  const { internal_eventEmitter } = useStdin();
  const { stdout } = useStdout();
  const [focused, setFocused] = useState<boolean | undefined>(undefined);
  const current = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const onInput = (raw: string) => {
      const next = focusReport(raw);
      if (next === undefined || next === current.current) return;
      current.current = next;
      setFocused(next);
    };
    internal_eventEmitter.on('input', onInput);
    if (stdout.isTTY) stdout.write('\u001b[?1004h');
    return () => {
      internal_eventEmitter.removeListener('input', onInput);
      if (stdout.isTTY) stdout.write('\u001b[?1004l');
    };
  }, [internal_eventEmitter, stdout, enabled]);
  return focused;
}
