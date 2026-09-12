/** V8 heap snapshots written to the working directory so memory growth can be inspected offline. */
import { join } from 'node:path';
import { writeHeapSnapshot as writeV8HeapSnapshot } from 'node:v8';

/** Longest sampling-point tag kept in a snapshot filename. */
const TAG_LIMIT = 48;

/** Build a snapshot filename from a sampling-point tag and a time.
 *
 * The tag is a user label such as `after-stress`; everything that could steer the write outside the
 * destination directory is folded into a dash, so a tag can never become a path.
 * @param tag - Sampling-point label.
 * @param time - Epoch milliseconds that keeps repeated snapshots distinct.
 * @returns A `.heapsnapshot` filename that names one file in one directory.
 */
export function heapSnapshotName(tag: string, time: number): string {
  const safe = tag.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, TAG_LIMIT).replace(/[.-]+$/, '');
  return `${safe || 'snapshot'}-${time}.heapsnapshot`;
}

/** Write a V8 heap snapshot into one directory.
 *
 * V8 serializes the whole heap synchronously, so the client pauses while the file is written; the
 * result is the artifact DevTools records, meant for offline leak analysis rather than display.
 * @param directory - Destination directory.
 * @param tag - Sampling-point label naming the file.
 * @param write - Snapshot writer; injectable so tests do not have to serialize a heap.
 * @returns Absolute path of the written snapshot.
 */
export function writeHeapSnapshot(directory: string, tag = 'snapshot', write: (file: string) => string = writeV8HeapSnapshot): string {
  return write(join(directory, heapSnapshotName(tag, Date.now())));
}
