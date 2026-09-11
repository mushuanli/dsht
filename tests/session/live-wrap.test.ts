/** Incremental live-tail wrapping must reproduce a one-shot wrap for every streaming delta. */
import test from 'node:test';
import assert from 'node:assert/strict';
import wrapAnsi from 'wrap-ansi';
import { Transcript, toolLine } from '../../src/session/transcript.ts';
import { historyLayout, releaseHistoryLayout } from '../../src/session/history.ts';

/** One-shot rendering of the live parts, as the layout computed it before wrapping incrementally. */
function oneShot(transcript: Transcript, width: number, reasoning: 'row' | 'full'): string[] {
  const rows = transcript.liveParts(width).flatMap(part => {
    const fold = part.kind === 'reasoning' && reasoning === 'row' && (part.closed || width < 60);
    const text = fold ? toolLine(`◇ /think live · ${part.text.slice(2)}`, width) : part.text;
    return wrapAnsi(text, width, { hard: true, trim: !['tool', 'success', 'error'].includes(part.kind) }).split('\n');
  });
  return transcript.liveToolOnly ? rows : ['✦ Assistant · streaming', ...rows];
}

/** Rows the layout currently renders, over one shared override set so its index is reused. */
function layoutRows(transcript: Transcript, width: number, reasoning: 'row' | 'full', overrides: ReadonlySet<number>): string[] {
  const layout = historyLayout(transcript, width, reasoning, overrides, reasoning);
  return layout.viewport(0, layout.length).map(row => row.text);
}

/** Deterministic generator, so a failure is reproducible from its seed. */
function dice(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x1_0000_0000; };
}

const ALPHABET = ['a', 'b', 'c', ' ', ' ', '\t', '\n', '中', '文', '.', '-'];

/** Stream random deltas one at a time and compare the layout with a one-shot wrap after each. */
function compareEveryDelta(seed: number, width: number, reasoning: 'row' | 'full', deltas: number, chunkSize: number): void {
  const next = dice(seed);
  const transcript = new Transcript();
  const overrides = new Set<number>();
  releaseHistoryLayout(transcript);
  transcript.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  let revision = 1;
  for (let step = 0; step < deltas; step++) {
    let delta = '';
    for (let index = 0; index < chunkSize; index++) delta += ALPHABET[Math.floor(next() * ALPHABET.length)]!;
    revision++;
    transcript.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision, index: step, chunk: { type: 'text-delta', index: 0, text: delta } } });
    // Without an identity the layout falls back to a one-shot wrap and this comparison proves nothing.
    assert.ok(transcript.liveParts(width).every(part => part.key !== undefined), `seed ${seed} delta ${step} has no live part identity`);
    assert.deepEqual(layoutRows(transcript, width, reasoning, overrides), oneShot(transcript, width, reasoning),
      `seed ${seed} width ${width} ${reasoning} delta ${step}`);
  }
}

test('incremental live wrapping matches a one-shot wrap for every delta', () => {
  for (const width of [16, 40, 79, 80, 100]) {
    for (const reasoning of ['full', 'row'] as const) {
      for (const seed of [1, 2, 3]) compareEveryDelta(seed, width, reasoning, 40, 5);
    }
  }
});

test('incremental live wrapping matches for long runs and whitespace-only deltas', () => {
  compareEveryDelta(11, 60, 'full', 120, 5);
  compareEveryDelta(12, 80, 'full', 40, 1);
  // Deltas that wrap to nothing must not make the carried row drift.
  const next = dice(13);
  const transcript = new Transcript();
  const overrides = new Set<number>();
  transcript.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  let revision = 1;
  for (let step = 0; step < 60; step++) {
    const delta = step % 3 === 0 ? `${' '.repeat(3)}x${' '.repeat(2)}` : ' '.repeat(1 + Math.floor(next() * 4));
    revision++;
    transcript.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision, index: step, chunk: { type: 'text-delta', index: 0, text: delta } } });
    assert.deepEqual(layoutRows(transcript, 24, 'full', overrides), oneShot(transcript, 24, 'full'), `step ${step}`);
  }
});

test('a folded live reasoning row is unchanged by bounding its source', () => {
  const transcript = new Transcript();
  const overrides = new Set<number>();
  transcript.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  for (const text of ['x '.repeat(20_000), `${' '.repeat(4_000)}tail words here`, 'ab'.repeat(9_000)]) {
    const fresh = new Transcript();
    fresh.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
    fresh.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 2, index: 0, chunk: { type: 'reasoning-delta', index: 0, text } } });
    releaseHistoryLayout(fresh);
    assert.deepEqual(layoutRows(fresh, 40, 'row', overrides), oneShot(fresh, 40, 'row'));
  }
  releaseHistoryLayout(transcript);
});
