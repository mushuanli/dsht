/** The notification hook: one write per transition, the configured method, the configured condition. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useAttentionNotify } from '../../src/ui/use-attention-notify.ts';

/** Collect every sequence the hook writes, so a case can assert exactly what the terminal received. */
function probe(env: NodeJS.ProcessEnv) {
  const writes: string[] = [];
  const sink = { write: (chunk: string) => { writes.push(chunk); return true; } };
  function Probe({ pending, busy, focused }: { pending?: string; busy: boolean; focused: boolean | undefined }) {
    useAttentionNotify({ ...(pending === undefined ? {} : { pending }), busy }, focused, env, sink);
    return React.createElement(Text, null, 'probe');
  }
  return { writes, Probe };
}

test('a finished turn or a waiting answer notifies once, and only while the pane is unfocused', async () => {
  const { writes, Probe } = probe({ TERM: 'xterm-kitty' });
  const ui = render(React.createElement(Probe, { busy: false, focused: false }));
  try {
    // The first render describes the state the operator is already looking at.
    assert.deepEqual(writes, []);
    ui.rerender(React.createElement(Probe, { busy: true, focused: false }));
    assert.deepEqual(writes, [], 'work starting is not worth an interruption');
    ui.rerender(React.createElement(Probe, { busy: false, focused: false }));
    assert.deepEqual(writes, ['\u001b]9;dsht finished\u0007']);
    // Staying idle says nothing, and a waiting interaction announces itself once.
    ui.rerender(React.createElement(Probe, { busy: false, focused: false }));
    assert.equal(writes.length, 1);
    ui.rerender(React.createElement(Probe, { busy: false, pending: 'q1', focused: false }));
    assert.deepEqual(writes.slice(1), ['\u001b]9;dsht needs an answer\u0007']);
    ui.rerender(React.createElement(Probe, { busy: false, pending: 'q1', focused: false }));
    assert.equal(writes.length, 2, 'the same question waiting does not ring again');
    // Focused again: the condition is the default `unfocused`, so the next transition is silent.
    ui.rerender(React.createElement(Probe, { busy: true, pending: 'q1', focused: true }));
    ui.rerender(React.createElement(Probe, { busy: false, pending: 'q1', focused: true }));
    assert.equal(writes.length, 2);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('a terminal that never reports focus still notifies', async () => {
  // tmux forwards focus events only with `focus-events on`, so "no answer" must not mean "never".
  const { writes, Probe } = probe({ DSHT_NOTIFY: 'bel' });
  const ui = render(React.createElement(Probe, { busy: true, focused: undefined }));
  try {
    ui.rerender(React.createElement(Probe, { busy: false, focused: undefined }));
    assert.deepEqual(writes, ['\u0007']);
    // Once the terminal does answer "focused", the client goes quiet again.
    ui.rerender(React.createElement(Probe, { busy: true, focused: true }));
    ui.rerender(React.createElement(Probe, { busy: false, focused: true }));
    assert.equal(writes.length, 1);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('the configured method and multiplexer decide the bytes', async () => {
  const bell = probe({ DSHT_NOTIFY: 'bel' });
  const bellUi = render(React.createElement(bell.Probe, { busy: true, focused: false }));
  try {
    bellUi.rerender(React.createElement(bell.Probe, { busy: false, focused: false }));
    assert.deepEqual(bell.writes, ['\u0007']);
  } finally { bellUi.unmount(); bellUi.cleanup(); }
  // Inside tmux the OSC 9 must be passed through, or tmux drops it.
  const tmux = probe({ TERM: 'xterm-kitty', TMUX: '/tmp/tmux-1000/default,1,0' });
  const tmuxUi = render(React.createElement(tmux.Probe, { busy: true, focused: false }));
  try {
    tmuxUi.rerender(React.createElement(tmux.Probe, { busy: false, focused: false }));
    assert.deepEqual(tmux.writes, ['\u001bPtmux;\u001b\u001b]9;dsht finished\u0007\u001b\\']);
  } finally { tmuxUi.unmount(); tmuxUi.cleanup(); }
  // Off means off, whatever else the terminal supports.
  const off = probe({ TERM: 'xterm-kitty', DSHT_NOTIFY: 'off' });
  const offUi = render(React.createElement(off.Probe, { busy: true, focused: false }));
  try {
    offUi.rerender(React.createElement(off.Probe, { busy: false, focused: false }));
    assert.deepEqual(off.writes, []);
  } finally { offUi.unmount(); offUi.cleanup(); }
});
