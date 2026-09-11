/** Storage domain: every filesystem operation the client performs. */
export { createPrivateFile, readPrivateFile, readText, removeFile, writeExclusiveStream, writePrivateFile } from './files.ts';
export { ensureDirectory, ensurePrivateDirectory, listEntries } from './directories.ts';
