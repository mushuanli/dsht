/** Synthetic terminal typing benchmark; excludes model latency and remote service time. */
import { performance } from 'node:perf_hooks';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/app.tsx';
import { Controller } from '../src/controller.ts';
import { Transcript } from '../src/transcript.ts';
import { host, until, snapshot } from '../tests/host.ts';

for (const count of [20, 500]) {
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
    const transcript = new MeasuredTranscript();
    transcript.accept({ ...snapshot, records: Array.from({ length: count }, (_, seq) => ({ type: 'event', event: {
      seq, type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: `Synthetic message ${seq}: ` + 'Text 中文 example. '.repeat(20) }] },
    } })) });
    controller.state.transcript = transcript;
    const press = async () => { await act(async () => {}); await act(async () => { ui.stdin.write('x'); }); };
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    for (let i = 0; i < 5; i++) await press();
    reads = 0;
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) { const start = performance.now(); await press(); samples.push(performance.now() - start); }
    samples.sort((a, b) => a - b);
    process.stdout.write(JSON.stringify({ messages: count, keystrokes: 30, historyReads: reads,
      medianMs: +samples[15]!.toFixed(2), p95Ms: +samples[28]!.toFixed(2) }) + '\n');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', descriptor);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    ui.unmount(); ui.cleanup(); await controller.stop(); await fixture.close();
  }
}
