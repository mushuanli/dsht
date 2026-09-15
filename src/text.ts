/** Terminal text hygiene shared by every layer; it knows nothing about the wire protocol.
 *
 * This module is deliberately dependency-free. It lives at the source root so `session/`, `ui/`
 * and `cli/` can clean remote text without importing the transport domain — the boundary rule that
 * `ui/` must never reach into `transport/`.
 */

import sliceAnsi from 'slice-ansi';

/** Remove terminal controls from remote text while retaining line breaks and tabs. */
export function safeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Return a displayable error without serializing request headers or credentials. */
export function errorText(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error));
}

/** Fit a tool operation to one terminal row without exposing the result body.
 * @param text - Tool name, status icon and optional operation.
 * @param width - Available terminal columns.
 * @returns A single line with an ellipsis when shortened.
 */
export function toolLine(text: string, width: number): string {
  const clean = safeText(text).replace(/\s+/gu, ' ').trim();
  if (width < 2) return width === 1 ? '…' : '';
  const clipped = sliceAnsi(clean, 0, width);
  return clipped.length < clean.length ? sliceAnsi(clean, 0, width - 1) + '…' : clean;
}
