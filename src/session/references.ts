/** Independent adapter for Harness path-only @ references; no file bytes are read. */
import type { FileReferenceCandidate } from '../transport/dsh.ts';
import { fileMention, type FileReference } from '../references.ts';

export type { FileReference } from '../references.ts';

/** Omit remote candidates whose path the mention grammar cannot insert safely.
 * @param candidates - Decoded `fileReferences/list` candidates.
 * @returns Ordered file and directory candidates.
 */
export function fileReferences(candidates: readonly FileReferenceCandidate[]): FileReference[] {
  return candidates.filter(row => fileMention(row) !== undefined);
}
