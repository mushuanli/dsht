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

/** Reduce text that must appear in a diagnostic log to a fact that is safe to paste elsewhere.
 *
 * A trace or a bug report leaves the machine, so text quoted into one is first stripped of the two
 * things that most often carry content out with it: absolute paths (which name a user, a project or a
 * client) and anything shaped like a credential. Whitespace collapses so a multi-line child's output
 * stays one field, and the result is bounded. This is for *diagnostic* text only: a message the
 * operator is meant to read in full never goes through it.
 * @param text - Text captured for diagnosis.
 * @param limit - Longest result, in characters.
 * @returns One bounded line with paths and credentials replaced.
 */
export function sanitizeTraceText(text: string, limit = 200): string {
  const flat = safeText(text)
    .replace(/\s+/gu, ' ')
    .trim()
    // A URL keeps its origin — that is the diagnosable part — while its path goes.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/'"]+)(\/[^\s'"]*)?/giu, '$1<path>')
    // A Windows drive path.
    .replace(/\b[A-Za-z]:\\[^\s'"]*/gu, '<path>')
    // A Unix absolute path, only from a boundary and only with a directory part, so an identifier such
    // as `session/agent-busy` is left alone.
    .replace(/(^|[\s'"=(:,])(?:\/(?:[^\s'":,)]+\/)+[^\s'":,)]*)/gu, '$1<path>')
    // Credentials last: a secret can sit inside what the earlier rules replaced.
    .replace(/\b(?:bearer|token|apikey|api[_-]?key|secret|password|passwd|authorization|cookie)\b\s*[:=]\s*\S+/giu, '<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '<redacted>')
    .replace(/\b[A-Fa-f0-9]{32,}\b/gu, '<redacted>');
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
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
