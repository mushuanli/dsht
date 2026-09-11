/** Private directory creation and listing for the client's configuration and state. */
import { lstat, mkdir, readdir } from 'node:fs/promises';

/** Create a directory tree with owner-only permissions, leaving an existing directory as it is.
 * @param path - Directory path.
 */
export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/** Create a directory tree and require it to stay owner-only.
 * @param path - Directory path.
 * @param label - Name used in the validation error, such as `Cookie directory`.
 */
export async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
  await ensureDirectory(path);
  const stat = await lstat(path);
  if (!stat.isDirectory() || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
    throw new Error(`${label} must be owned by the current user with permissions 0700`);
  }
}

/** List the entry names of one directory.
 * @param path - Directory path.
 * @returns Entry names in filesystem order.
 */
export async function listEntries(path: string): Promise<string[]> { return readdir(path); }
