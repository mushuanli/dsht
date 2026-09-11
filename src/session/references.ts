/** Independent adapter for Harness path-only @ references; no file bytes are read. */
import { array, object, string } from '../transport/wire.ts';

/** A path relative to the remote session's working directory. */
export interface FileReference { path: string; kind: 'file' | 'directory' }

/** Find the unfinished reference at the end of the draft; email addresses do not trigger it.
 * @param text - Complete composer draft.
 * @returns The replaceable token and host query, or undefined outside a reference.
 */
export function activeReference(text: string): { prefix: string; query: string; quoted: boolean } | undefined {
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(text);
  if (quoted) return { prefix: quoted[1]!, query: quoted[2]!, quoted: true };
  const plain = /(?:^|\s)(@([^\s"]*))$/u.exec(text);
  if (plain) return { prefix: plain[1]!, query: plain[2]!, quoted: false };
  return undefined;
}

/** Encode a candidate in Harness prompt syntax; directories keep completion open.
 * @param candidate - Remote path and entry kind.
 * @param quoted - Preserve an explicitly opened quote.
 * @returns Mention text, or undefined for paths the mention grammar cannot encode.
 */
export function fileMention(candidate: FileReference, quoted = false): string | undefined {
  const path = candidate.path + (candidate.kind === 'directory' ? '/' : '');
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
  if (!quoted && !/\s/u.test(path)) return `@${path}`;
  return `@"${path}${candidate.kind === 'file' ? '"' : ''}`;
}

/** Validate remote candidates and omit paths that cannot be inserted safely.
 * @param value - Decoded fileReferences/list result.
 * @returns Ordered file and directory candidates.
 */
export function fileReferences(value: unknown): FileReference[] {
  return array(value).map<FileReference>(item => {
    const row = object(item);
    if (row.kind !== 'file' && row.kind !== 'directory') throw new Error('Unknown file reference kind');
    return { path: string(row.path), kind: row.kind };
  }).filter(row => fileMention(row) !== undefined);
}
