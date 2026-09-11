/** Synthetic terminal benchmark for keystroke latency and per-frame transcript cost, excluding model latency and remote service time. */
import { performance } from 'node:perf_hooks';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { App } from '../../src/ui/app.tsx';
import { Controller } from '../../src/controller/controller.ts';
import { historyLayout } from '../../src/session/history.ts';
import { Transcript } from '../../src/session/transcript.ts';
import { host, until, snapshot } from '../../tests/support/host.ts';

const median = (samples: number[]) => samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

for (const count of [20, 500, 2000]) {
  const fixture = await host();
  const controller = new Controller(fixture.url, 'fixture-token', 's1');
  const ui = render(<App controller={controller} />);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  let reads = 0;
  class MeasuredTranscript extends Transcript {
    override messagesForWidth(width: number) { reads++; return super.messagesForWidth(width); }
  }
  try {
    controller.start();
    await until(() => controller.state.transcript.ready);
    const records = Array.from({ length: count }, (_, seq) => ({ type: 'event', event: {
      seq, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: `Synthetic message ${seq}: ` + 'Text 中文 example. '.repeat(20) }] },
    } }));
    const transcript = new MeasuredTranscript();
    transcript.accept({ ...snapshot, records });
    controller.state.transcript = transcript;
    const press = async () => { await act(async () => {}); await act(async () => { ui.stdin.write('x'); }); };
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    for (let i = 0; i < 5; i++) await press();
    reads = 0;
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) { const start = performance.now(); await press(); samples.push(performance.now() - start); }
    samples.sort((a, b) => a - b);

    // One packed chunk row per frame reproduces the streaming path an older host publishes.
    const streaming = new Transcript();
    streaming.accept({ ...snapshot, assistantStream: undefined, records });
    const chunk = (seq: number) => ({ type: 'event', event: { seq, surfaceOp: 'append', type: 'chunkrow/text-chunks',
      data: { turn: 1, step: 1, index: 0, texts: ['Text 中文 example. '], dt: [] } } });
    const stream = (seq: number) => { streaming.accept(chunk(seq)); historyLayout(streaming, 80); };
    for (let i = 0; i < 5; i++) stream(count + i);
    const frames: number[] = [];
    for (let i = 0; i < 30; i++) { const start = performance.now(); stream(count + 5 + i); frames.push(performance.now() - start); }
    process.stdout.write(JSON.stringify({ messages: count, keystrokes: 30, historyReads: reads,
      keystrokeMedianMs: +samples[15]!.toFixed(2), keystrokeP95Ms: +samples[28]!.toFixed(2),
      frameMedianMs: +median(frames).toFixed(2), frameP95Ms: +frames.slice().sort((a, b) => a - b)[28]!.toFixed(2) }) + '\n');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', descriptor);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    ui.unmount(); ui.cleanup(); await controller.stop(); await fixture.close();
  }
}
