/** Width-aware history layout shared by scrolling and explicit message jumps. */
import wrapAnsi from 'wrap-ansi';
import type { Message, Transcript } from './transcript.ts';

/** Terminal rows per projected message and reasoning mode; unchanged messages keep their rows. */
const rows = new WeakMap<Message, { width: number; reasoning: Reasoning; lines: string[] }>();

/** Committed reasoning shows as one row by default and keeps its complete text when expanded. */
export type Reasoning = 'row' | 'full';

/** Split one projected message into role heading and wrapped rows, reusing an unchanged message.
 * @param message - Projected durable message.
 * @param width - Available terminal columns.
 * @param reasoning - Whether committed reasoning keeps its complete text.
 * @returns Rows for one message, ending with its separating blank row.
 */
function rowsFor(message: Message, width: number, reasoning: Reasoning): string[] {
  const cached = rows.get(message);
  if (cached?.width === width && cached.reasoning === reasoning) return cached.lines;
  const text = reasoning === 'row' ? message.folded ?? message.text : message.text;
  const lines = [...(message.compact ? [] : [message.role]), ...wrapAnsi(text, width, { hard: true }).split('\n'), ''];
  rows.set(message, { width, reasoning, lines });
  return lines;
}

/** Wrapped live text from the previous call; most frames change metrics rather than streamed text. */
let live: { text: string; width: number; lines: string[] } | undefined;

/** Split transient streamed text into rows, reusing the previous frame's rows when the text repeats. */
function liveLines(text: string, width: number): string[] {
  if (live?.text === text && live.width === width) return live.lines;
  const lines = wrapAnsi(text, width, { hard: true }).split('\n');
  live = { text, width, lines };
  return lines;
}

/** Lay out visible conversation records and retain their first terminal row.
 * @param transcript - Loaded history and active assistant output.
 * @param width - Available terminal columns.
 * @param reasoning - Whether committed reasoning keeps its complete text; streamed text is always complete.
 * @returns Rows, messages for the history picker, and record-to-row offsets.
 */
export function historyLayout(transcript: Transcript, width: number, reasoning: Reasoning = 'row') {
  const messages = transcript.messagesForWidth(width);
  const lines: string[] = [];
  const offsets = new Map<number, number>();
  for (const message of messages) {
    offsets.set(message.seq, lines.length);
    lines.push(...rowsFor(message, width, reasoning));
  }
  const streamed = transcript.liveTextForWidth(width);
  if (streamed) lines.push(...(transcript.liveToolOnly ? [] : ['Assistant · streaming']), ...liveLines(streamed, width));
  return { messages, lines, offsets, first: transcript.beforeSeq };
}
