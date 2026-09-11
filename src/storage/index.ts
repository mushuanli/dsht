/** Storage domain: every filesystem operation the client performs. */
export { appendPrivateFile, createPrivateFile, readPrivateFile, readText, removeFile, writeExclusiveStream, writePrivateFile } from './files.ts';
export { ensureDirectory, ensurePrivateDirectory, listEntries } from './directories.ts';
