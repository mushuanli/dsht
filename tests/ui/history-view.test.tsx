/** Pin viewport row geometry: empty separator rows keep their line and spans stay inside their row. */
import '../support/no-color.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { HistoryViewport } from '../../src/ui/chat/history-view.tsx';

test('an empty row keeps its line and spans render inside their own row', () => {
  const ui = render(<HistoryViewport rows={[
    { text: 'alpha', kind: 'assistant' },
    { text: '', kind: 'muted' },
    { text: 'styled', kind: 'assistant', spans: [{ text: 'sty', bold: true }, { text: 'led' }] },
  ]} />);
  try {
    // The empty row is a message separator: an empty text node would collapse and shift the rows below it.
    assert.equal(ui.lastFrame(), 'alpha\n\nstyled');
  } finally { ui.unmount(); ui.cleanup(); }
});
