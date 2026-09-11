/** Every filesystem read and write the client performs; no other module opens a file. */
import { constants } from 'node:fs';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Read a UTF-8 file; an absent file is an ordinary result, not a failure.
 * @param path - Absolute file path.
 * @returns File contents, or undefined when the file does not exist.
 */
export async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

/** Read a user-private file, rejecting a symlink, a foreign owner, or group/other access.
 * @param path - Absolute file path.
 * @param label - Name used in the validation error, such as `Cookie file`.
 * @returns File contents, or undefined when the file does not exist.
 */
export async function readPrivateFile(path: string, label: string): Promise<string | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
      throw new Error(`${label} must be owned by the current user with permissions 0600`);
    }
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

/** Replace a file atomically with owner-only contents, leaving no partial file behind.
 * @param path - Destination path.
 * @param contents - Complete file contents.
 */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await removeFile(temporary); }
}

/** Create an owner-only file only when it does not exist.
 * @param path - Destination path.
 * @param contents - Complete file contents.
 * @returns False when the file already existed, leaving it untouched.
 */
export async function createPrivateFile(path: string, contents: string): Promise<boolean> {
  try { await writeFile(path, contents, { mode: 0o600, flag: 'wx' }); return true; }
  catch (error) { if (isCode(error, 'EEXIST')) return false; throw error; }
}

/** Stream bytes into a new owner-only file, removing it unless the write completed.
 *
 * The destination is created before the source is requested, so an existing file fails without
 * contacting the host, and a source or streaming failure removes the partial file.
 * @param path - Destination path; an existing file is never replaced.
 * @param source - Produces the byte stream once the destination exists.
 * @param signal - Cancels the write and removes the partial file.
 */
export async function writeExclusiveStream(path: string, source: () => Promise<AsyncIterable<Uint8Array>>, signal?: AbortSignal): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  let complete = false;
  try {
    await file.writeFile(await source(), { signal });
    signal?.throwIfAborted();
    complete = true;
  } finally {
    try { await file.close(); } finally { if (!complete) await removeFile(path); }
  }
}

/** Remove a file, treating an already absent file as success.
 * @param path - File to remove.
 */
export async function removeFile(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) { if (!isMissing(error)) throw error; }
}

/** Recognize one error code without assuming the error's prototype. */
function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Whether an operation failed because the path does not exist. */
function isMissing(error: unknown): boolean { return isCode(error, 'ENOENT'); }
