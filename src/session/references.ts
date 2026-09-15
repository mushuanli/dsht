/** Independent adapter for Harness path-only @ references; no file bytes are read. */
import { array, object, string } from '../transport/wire.ts';
import { fileMention, type FileReference } from '../references.ts';

export type { FileReference } from '../references.ts';

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
