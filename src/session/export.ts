/** Stream authenticated session archives to exclusive local files. */
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Client } from '../transport/client.ts';

/** Save an archive without overwriting an existing file or retaining a partial download.
 * @param client - Authenticated host transport.
 * @param sessionId - Selected session to export.
 * @param destination - Local filename, defaulting to a timestamped ZIP in the working directory.
 * @param signal - Caller-owned cancellation.
 * @returns Absolute saved filename.
 */
export async function saveSessionLog(client: Client, sessionId: string, destination: string | undefined, signal: AbortSignal): Promise<string> {
  const path = resolve(destination ?? `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.zip`);
  const file = await open(path, 'wx', 0o600);
  let complete = false;
  try {
    const response = await client.sessionLog(sessionId, signal);
    if (!response.body) throw new Error('Session log export has no body');
    const reader = response.body.getReader();
    async function* chunks() {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          yield chunk.value;
        }
      } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    }
    await file.writeFile(chunks(), { signal });
    signal.throwIfAborted();
    complete = true;
    return path;
  } finally {
    try { await file.close(); } finally { if (!complete) await unlink(path); }
  }
}
