/** The shared loop progress line renders any protocol's snapshot without naming a command. */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { LoopStatus } from '../../src/ui/chat/loop-status.tsx';
import type { LoopProgress } from '../../src/contracts.ts';

const PROGRESS: LoopProgress = {
  runId: 'run-1', title: 'Design review', startedAt: Date.now(), active: true,
  from: 1, to: 10, total: 10, scope: 'rounds 1–10/10', score: 8, tries: 10,
  step: 3, attempt: 2, best: 7.5, phase: 'running',
};

test('a running loop shows its protocol title, position and best score', () => {
  const ui = render(<LoopStatus progress={PROGRESS} />);
  try { assert.equal(ui.lastFrame(), 'Design review · step 3/10 · attempt 2/10 · best 7.5/8'); }
  finally { ui.unmount(); ui.cleanup(); }
});

test('a finished loop appends its terminal phase, and a pass says which rounds it covered', () => {
  for (const phase of ['passed', 'exhausted', 'blocked', 'cancelled'] as const) {
    const ui = render(<LoopStatus progress={{ ...PROGRESS, phase }} />);
    // Only `passed` makes a claim about coverage, so only it carries the scope.
    const scope = phase === 'passed' ? ' · rounds 1–10/10' : '';
    try { assert.equal(ui.lastFrame(), `Design review · step 3/10 · attempt 2/10 · best 7.5/8 · ${phase}${scope}`); }
    finally { ui.unmount(); ui.cleanup(); }
  }
});

test('a pass over a selected range says so instead of claiming the whole record', () => {
  const ui = render(<LoopStatus progress={{ ...PROGRESS, to: 3, phase: 'passed', scope: 'rounds 1–3/10 · selected range' }} />);
  try { assert.equal(ui.lastFrame(), 'Design review · step 3/3 · attempt 2/10 · best 7.5/8 · passed · rounds 1–3/10 · selected range'); }
  finally { ui.unmount(); ui.cleanup(); }
});

test('a run a verifier ended early shows the reason it gave', () => {
  const ui = render(<LoopStatus progress={{ ...PROGRESS, phase: 'blocked', exit: { reason: '没有取消端点' } }} />);
  try { assert.equal(ui.lastFrame(), 'Design review · step 3/10 · attempt 2/10 · best 7.5/8 · blocked · 没有取消端点'); }
  finally { ui.unmount(); ui.cleanup(); }
});

test('a named step is shown between the title and the position', () => {
  const ui = render(<LoopStatus progress={{ ...PROGRESS, stepLabel: '接口审查' }} />);
  try { assert.equal(ui.lastFrame(), 'Design review · 接口审查 · step 3/10 · attempt 2/10 · best 7.5/8'); }
  finally { ui.unmount(); ui.cleanup(); }
});

test('another protocol renders through the same line', () => {
  const ui = render(<LoopStatus progress={{ ...PROGRESS, title: 'Security review', score: 9.5, phase: 'passed' }} />);
  try { assert.equal(ui.lastFrame(), 'Security review · step 3/10 · attempt 2/10 · best 7.5/9.5 · passed · rounds 1–10/10'); }
  finally { ui.unmount(); ui.cleanup(); }
});

test('a live sub-state without a host turn of its own is named', () => {
  const ui = render(<LoopStatus progress={{ ...PROGRESS, activity: 'verify' }} />);
  try { assert.equal(ui.lastFrame(), 'Design review · step 3/10 · attempt 2/10 · best 7.5/8 · verify'); }
  finally { ui.unmount(); ui.cleanup(); }
});

test('a work turn is not repeated, because the session already shows it working', () => {
  const ui = render(<LoopStatus progress={{ ...PROGRESS, activity: 'turn' }} />);
  try { assert.equal(ui.lastFrame(), 'Design review · step 3/10 · attempt 2/10 · best 7.5/8'); }
  finally { ui.unmount(); ui.cleanup(); }
});
