/** Measure indexed streaming layouts across loaded history sizes without a host or model request. */
import { performance } from 'node:perf_hooks';
import { Transcript } from '../../src/session/transcript.ts';
import { historyLayout } from '../../src/session/history.ts';
import wrapAnsi from 'wrap-ansi';

for (const count of [500, 2000, 10000]) {
  const transcript = new Transcript();
  transcript.accept({ type: 'snapshot', cursor: count, hasMore: false, assistantStream: { revision: 0 },
    records: Array.from({ length: count }, (_, seq) => ({ type: 'event', event: {
      seq, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [
        { type: 'reasoning', text: 'Reasoning detail 中文. '.repeat(200) },
        { type: 'text', text: 'Answer text 中文. '.repeat(20) },
      ] } },
    } })),
  });
  historyLayout(transcript, 80);
  transcript.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
  const samples: number[] = [];
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    transcript.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: i + 2, index: i,
      chunk: { type: 'text-delta', index: 0, text: 'Next word. ' },
    } });
    const layout = historyLayout(transcript, 80);
    layout.viewport(Math.max(0, layout.length - 25), layout.length);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ messages: count, medianMs: +samples[20]!.toFixed(3), p95Ms: +samples[38]!.toFixed(3),
    heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1) }));
}

// A long single-part stream, against the whole-text wrap the layout performed on every frame.
const WIDTH = 100;
const FRAMES = 400;
const CHUNK = 24;
const stream = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod 中文宽度 '.repeat(80);
const live = new Transcript();
live.accept({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1 } });
let wholeMs = 0;
for (let frame = 0; frame < FRAMES; frame++) {
  const start = performance.now();
  wrapAnsi(stream.slice(0, (frame + 1) * CHUNK), WIDTH, { hard: true, trim: true });
  wholeMs += performance.now() - start;
}
const incrementalStart = performance.now();
for (let frame = 0; frame < FRAMES; frame++) {
  live.accept({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: frame + 2, index: frame,
    chunk: { type: 'text-delta', index: 0, text: stream.slice(frame * CHUNK, (frame + 1) * CHUNK) },
  } });
  const layout = historyLayout(live, WIDTH);
  layout.viewport(Math.max(0, layout.length - 25), layout.length);
}
const incrementalMs = performance.now() - incrementalStart;
console.log(JSON.stringify({ streamChars: FRAMES * CHUNK, frames: FRAMES, wholeTextWrapMs: +wholeMs.toFixed(1),
  incrementalLayoutMs: +incrementalMs.toFixed(1), ratio: +(wholeMs / incrementalMs).toFixed(1) }));
