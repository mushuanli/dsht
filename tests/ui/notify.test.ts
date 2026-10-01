/** The attention notification: which sequence, when, and never twice for one moment. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attentionAllowed, attentionTransition, notificationBytes, notificationMessage, resolveNotify, supportsOsc9,
} from '../../src/ui/notify.ts';

test('auto picks OSC 9 on the terminals that show it and the bell everywhere else', () => {
  // A multiplexer does not change which outer terminal is present, so TMUX is not consulted here.
  assert.equal(supportsOsc9({ TERM_PROGRAM: 'WezTerm', TMUX: '/tmp/x' }), true);
  assert.equal(supportsOsc9({ TERM: 'xterm-kitty' }), true);
  assert.equal(supportsOsc9({ ITERM_SESSION_ID: 'w0t0p0' }), true);
  // Windows Terminal sets WT_SESSION and does not take OSC 9 the same way, so it gets the bell.
  assert.equal(supportsOsc9({ WT_SESSION: 'x', TERM_PROGRAM: 'WezTerm' }), false);
  assert.equal(supportsOsc9({ TERM: 'xterm-256color', TERM_PROGRAM: 'tmux', TMUX: '/tmp/x' }), false);
  assert.equal(resolveNotify({ TERM_PROGRAM: 'ghostty' }).method, 'osc9');
  assert.equal(resolveNotify({ TERM: 'screen-256color', TMUX: '/tmp/x' }).method, 'bel');
  // An explicit setting wins, an explicit empty value is the default, and a typo fails soft.
  assert.equal(resolveNotify({ TERM_PROGRAM: 'ghostty', DSHT_NOTIFY: 'bel' }).method, 'bel');
  assert.equal(resolveNotify({ DSHT_NOTIFY: 'off' }).method, 'off');
  assert.equal(resolveNotify({ DSHT_NOTIFY: 'nonsense', TERM: 'xterm-kitty' }).method, 'bel');
  assert.equal(resolveNotify({ DSHT_NOTIFY_WHEN: 'always' }).when, 'always');
  assert.equal(resolveNotify({ DSHT_NOTIFY_WHEN: 'sometimes' }).when, 'unfocused');
});

test('each method writes exactly the sequence its terminal expects', () => {
  assert.equal(notificationBytes('off', 'dsht finished', false), undefined);
  assert.equal(notificationBytes('bel', 'dsht finished', false), '\u0007');
  // OSC 9 outside tmux is the plain sequence iTerm2/kitty/WezTerm parse.
  assert.equal(notificationBytes('osc9', 'dsht finished', false), '\u001b]9;dsht finished\u0007');
  // Inside tmux it must be passed through with a DCS wrapper, ESC doubled inside the payload.
  assert.equal(notificationBytes('osc9', 'dsht finished', true), '\u001bPtmux;\u001b\u001b]9;dsht finished\u0007\u001b\\');
  assert.equal(notificationBytes('osc9', 'a\u001bb', true), '\u001bPtmux;\u001b\u001b]9;a\u001b\u001bb\u0007\u001b\\');
  assert.equal(notificationMessage('needs-input'), 'dsht needs an answer');
  assert.equal(notificationMessage('finished'), 'dsht finished');
});

test('only a transition announces, and only when the condition allows it', () => {
  const idle = { busy: false } as const;
  const working = { busy: true } as const;
  const waiting = { busy: true, pending: 'q1' } as const;
  // The first observation describes the state the operator is already looking at.
  assert.equal(attentionTransition(undefined, working), undefined);
  assert.equal(attentionTransition(undefined, waiting), undefined);
  // A new interaction interrupts; the same one waiting across renders does not.
  assert.equal(attentionTransition(working, waiting), 'needs-input');
  assert.equal(attentionTransition(waiting, waiting), undefined);
  assert.equal(attentionTransition(idle, waiting), 'needs-input');
  // Work that stops is announced once, and an idle client that stays idle is silent.
  assert.equal(attentionTransition(working, idle), 'finished');
  assert.equal(attentionTransition(idle, idle), undefined);
  // A turn that ends while a question is waiting announces the question, which is the actionable fact.
  assert.equal(attentionTransition({ busy: true, pending: 'q1' }, { busy: true, pending: 'q2' }), 'needs-input');
  assert.equal(attentionTransition(waiting, idle), 'finished');
  // The condition: unfocused is the default, so the client stays quiet while it is being watched —
  // and it only *knows* it is being watched once the terminal said so. tmux without `focus-events on`
  // never says anything, and a condition that could never be satisfied would mean no notification at
  // all, so an unanswered focus report counts as "not known to be focused".
  const unfocused = resolveNotify({ TERM_PROGRAM: 'ghostty', DSHT_NOTIFY_WHEN: 'unfocused' });
  assert.equal(attentionAllowed(unfocused, true), false);
  assert.equal(attentionAllowed(unfocused, false), true);
  assert.equal(attentionAllowed(unfocused, undefined), true, 'no answer from the terminal is not "focused"');
  assert.equal(attentionAllowed(resolveNotify({ DSHT_NOTIFY: 'off' }), false), false);
  assert.equal(attentionAllowed({ method: 'bel', when: 'always' }, true), true);
});
