/** Storage domain: every filesystem operation the client performs. */
export { appendPrivateFile, createPrivateFile, readPrivateFile, readText, removeFile, renameFile, writeExclusiveStream, writePrivateFile } from './files.ts';
export { ensureDirectory, ensurePrivateDirectory, listEntries } from './directories.ts';
export { heapSnapshotName, writeHeapSnapshot } from './heap-snapshot.ts';
