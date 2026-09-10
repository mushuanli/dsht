/** Width-aware history layout shared by scrolling and explicit message jumps. */
import wrapAnsi from 'wrap-ansi';
import type { Transcript } from './transcript.ts';

/** Lay out visible conversation records and retain their first terminal row.
 * @param transcript - Loaded history and active assistant output.
 * @param width - Available terminal columns.
 * @returns Rows, messages for the history picker, and record-to-row offsets.
 */
export function historyLayout(transcript: Transcript, width: number) {
  const wrap = (value: string) => wrapAnsi(value, width, { hard: true }).split('\n');
  const messages = transcript.messagesForWidth(width);
  const lines: string[] = [];
  const offsets = new Map<number, number>();
  for (const message of messages) {
    offsets.set(message.seq, lines.length);
    lines.push(...(message.compact ? [] : [message.role]), ...wrap(message.text), '');
  }
  const live = transcript.liveTextForWidth(width);
  if (live) lines.push(...(transcript.liveToolOnly ? [] : ['Assistant · streaming']), ...wrap(live));
  return { messages, lines, offsets, first: transcript.beforeSeq };
}

/** Parse an exact visible-record sequence or an endpoint alias.
 * @param value - Text after /jump.
 * @returns A non-negative sequence, first, or last.
 */
export function jumpTarget(value: string): number | 'first' | 'last' {
  if (value === 'first' || value === 'last') return value;
  if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  throw new Error('Use /jump <record sequence|first|last>; /history lists record sequences');
}
