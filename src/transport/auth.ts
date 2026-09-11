/** Origin-scoped cookie persistence; launch tokens are never written to disk. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client, HttpError } from './client.ts';

/** Fatal authentication failure requiring a new startup token. */
export class AuthenticationRequired extends Error {}

/** Private, atomic cookie files, separated by the complete HTTP origin. */
export class CookieStore {
  constructor(readonly directory = process.env.DSHT_AUTH_DIR
    ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dsht', 'auth')) {}

  /** Read an unexpired cookie, rejecting unsafe permissions or malformed storage. */
  async load(origin: string): Promise<string | undefined> {
    let handle;
    try { handle = await open(this.path(origin), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
        throw new Error('Cookie file must be owned by the current user with permissions 0600');
      }
      const raw = await handle.readFile('utf8');
      let saved: unknown;
      try { saved = JSON.parse(raw); }
      catch { throw new Error('Invalid cookie file JSON. Remove the origin cookie file and log in again.'); }
      if (saved === null || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1
        || !('origin' in saved) || saved.origin !== origin || !('cookie' in saved) || typeof saved.cookie !== 'string'
        || !('expiresAt' in saved) || typeof saved.expiresAt !== 'number' || !Number.isSafeInteger(saved.expiresAt)) {
        throw new Error('Invalid saved cookie. Remove the origin cookie file and log in again.');
      }
      return saved.expiresAt > Date.now() ? saved.cookie : undefined;
    } finally { await handle.close(); }
  }

  /** Atomically save a persistent host cookie with owner-only POSIX permissions. */
  async save(origin: string, cookie: string, expiresAt: number): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
      throw new Error('Cookie directory must be owned by the current user with permissions 0700');
    }
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify({ version: 1, origin, cookie, expiresAt }) + '\n'); }
      finally { await handle.close(); }
      await rename(temporary, this.path(origin));
    } finally {
      try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw error; }
    }
  }

  private path(origin: string): string {
    return join(this.directory, `${createHash('sha256').update(origin).digest('hex')}.json`);
  }
}

/** Reuse a validated cookie first; only authentication rejection permits token fallback. */
export async function login(client: Client, token: string | undefined, store: CookieStore): Promise<void> {
  const cookie = await store.load(client.base.origin);
  if (cookie) {
    client.restoreCookie(cookie);
    try { await client.call('session/list', { _request: {} }); return; }
    catch (error) { if (!(error instanceof HttpError) || error.status !== 401) throw error; }
  }
  if (!token) throw new AuthenticationRequired('Login required: export DSH_TOKEN, or export DSH_URL as the URL printed by dsh web');
  await client.authenticate(token);
  const session = client.persistentCookie;
  if (session) await store.save(client.base.origin, session.cookie, session.expiresAt);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
