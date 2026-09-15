/** The shared loop progress line renders any protocol's snapshot without naming a command. */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { LoopStatus } from '../../src/ui/chat/loop-status.tsx';
import type { LoopProgress } from '../../src/contracts.ts';

const PROGRESS: LoopProgress = {
  title: 'Design review', from: 1, to: 10, score: 8, tries: 10,
  step: 3, attempt: 2, best: 7.5, phase: 'running',
};

test('a running loop shows its protocol title, position and best score', () => {
  const ui = render(<LoopStatus progress={PROGRESS} />);
  try { assert.equal(ui.lastFrame(), 'Design review · step 3/10 · attempt 2/10 · best 7.5/8'); }
  finally { ui.unmount(); ui.cleanup(); }
});

test('a finished loop appends its terminal phase', () => {
  for (const phase of ['passed', 'exhausted', 'cancelled'] as const) {
    const ui = render(<LoopStatus progress={{ ...PROGRESS, phase }} />);
    try { assert.equal(ui.lastFrame(), `Design review · step 3/10 · attempt 2/10 · best 7.5/8 · ${phase}`); }
    finally { ui.unmount(); ui.cleanup(); }
  }
});

test('another protocol renders through the same line', () => {
  const ui = render(<LoopStatus progress={{ ...PROGRESS, title: 'Security review', score: 9.5, phase: 'passed' }} />);
  try { assert.equal(ui.lastFrame(), 'Security review · step 3/10 · attempt 2/10 · best 7.5/9.5 · passed'); }
  finally { ui.unmount(); ui.cleanup(); }
});
