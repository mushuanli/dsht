/** Offline export of the retained conversation, with inert diagrams and MathJax MathML. */
import { resolve } from 'node:path';
import { writeExclusiveStream } from '../storage/index.ts';
import type { Transcript } from './transcript.ts';
import { markdownHtml } from './markdown.ts';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Save the currently retained messages and live tail without fetching older history or overwriting files.
 * @param transcript - Selected conversation, captured before writing begins.
 * @param sessionId - Selected session identifier for the document title and default filename.
 * @param destination - Optional local HTML filename.
 * @param signal - Cancels the write and removes incomplete output.
 * @returns Absolute filename of the saved offline document.
 */
export async function saveTranscriptHtml(transcript: Transcript, sessionId: string, destination: string | undefined, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const messages = transcript.messagesForWidth(120);
  const live = transcript.liveParts(120);
  const partsHtml = (parts: typeof live) => parts.map(part => part.kind === 'text' ? markdownHtml(part.text)
    : `<pre>${escape(part.text)}</pre>`).join('\n');
  const body = messages.map(message => `<article><h2>${escape(message.role)}</h2>${partsHtml(message.parts)}</article>`).join('\n')
    + (live.length ? `<article><h2>Assistant · streaming</h2>${partsHtml(live)}</article>` : '');
  const title = escape(`Session ${sessionId}`);
  const document = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${title}</title><style>
body{font:16px/1.6 system-ui,sans-serif;max-width:1000px;margin:2em auto;padding:0 1em;color:#222;background:#fff}
article{border-top:1px solid #ddd;padding:1em 0}pre,code{font-family:ui-monospace,monospace;background:#f5f5f5}
pre{padding:1em;white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;table-layout:fixed}
td,th{border:1px solid #ccc;padding:.5em;overflow-wrap:anywhere}img{max-width:100%;height:auto}math[display=block]{overflow:auto;padding:1em 0}
blockquote{border-left:3px solid #ccc;padding-left:1em;margin-left:0}a{overflow-wrap:anywhere}
</style></head><body><h1>${title}</h1><p>Loaded conversation only; older or evicted messages are not included. Tool rows are summaries.</p>
${body}</body></html>
`;
  const path = resolve(destination ?? `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.html`);
  await writeExclusiveStream(path, async () => (async function* () { yield Buffer.from(document); })(), signal);
  return path;
}
