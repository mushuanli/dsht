/** Local transcript bars: what they render, and which of their rows a click opens. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShellController, localSourceId, type ShellBlock } from '../../src/shell/index.ts';
import { blockRows, mergeShellRuns } from '../../src/ui/chat/shell-view.ts';
import type { HistoryRow } from '../../src/contracts.ts';

/** A minimal two-row layout with one message, enough to place blocks after it. */
function fakeLayout(): { length: number; messages: { seq: number }[]; offsets: ReadonlyMap<number, number>;
  viewport(start: number, end: number): HistoryRow[] } {
  return {
    length: 2,
    messages: [{ seq: 1 }],
    offsets: new Map([[1, 0]]),
    viewport: (start, end) => Array.from({ length: Math.max(0, end - start) },
      (_, index) => ({ text: `host${start + index}`, kind: 'assistant' as const })),
  };
}

/** One block, with only the fields a placement test cares about set explicitly. */
function block(id: number, overrides: Partial<ShellBlock> = {}): ShellBlock {
  return { id, kind: 'shell', source: localSourceId(id), command: `echo ${id}`, lines: [], dropped: 0,
    anchor: 1, status: 'exited', startedAt: 0, endedAt: 1, ...overrides };
}

test('a ! run points at its own lines, a note at whatever it announces', () => {
  const shell = new ShellController({ publish: () => {}, cwd: () => '/tmp', env: () => ({}), anchor: () => 4 });
  const run = shell.note('/loop design-review 1–10 · pass 8 · ≤3 tries');
  assert.equal(run.kind, 'note');
  assert.equal(run.source, undefined);
  assert.equal(run.status, 'exited');
  // The bar is placed where the run started, not at the top of the transcript.
  assert.equal(run.anchor, 4);
  // Linking points the newest note at the session doing the work, and is idempotent.
  shell.link('s-child');
  assert.equal(shell.runs.at(-1)!.source, 's-child');
  shell.link('s-child');
  assert.equal(shell.runs.at(-1)!.source, 's-child');
  shell.link('s-next');
  assert.equal(shell.runs.at(-1)!.source, 's-next');
});

test('a note renders its command and says whether a session can be read yet', () => {
  const unlinked = blockRows(block(1, { kind: 'note', source: undefined, command: '/loop design-review 1–10' }), 60);
  assert.equal(unlinked[0]!.text, '/loop design-review 1–10');
  assert.equal(unlinked[0]!.highlight, true);
  assert.match(unlinked[1]!.text, /no readable session yet/);
  const linked = blockRows(block(1, { kind: 'note', command: '/loop design-review 1–10' }), 60);
  assert.match(linked[1]!.text, /shell:1 · click this bar to read it/);
  // A `!` block keeps its own rendering: the command bar, then its output under the marker.
  const shell = blockRows(block(2, { lines: ['done'] }), 60);
  assert.equal(shell[0]!.text, '! echo 2');
  assert.match(shell[1]!.text, /⎿  done/);
});

test('only a block bar is a click target, and it carries the source it opens', () => {
  const first = block(1, { lines: ['one', 'two'] });
  const second = block(2, { source: 's-child', kind: 'note', command: '/loop design-review' });
  const merged = mergeShellRuns(fakeLayout(), [first, second], 60);
  // The first bar sits after the two host rows; the second follows the first block's three rows
  // (bar plus two output lines), and each map entry is the bar alone.
  assert.equal(merged.sources.get(2), 'shell:1');
  assert.equal(merged.sources.get(5), 's-child');
  assert.equal(merged.sources.size, 2);
  assert.equal(merged.total, 7);
  // A block with no source is still rendered; it just has nothing to open.
  const plain = mergeShellRuns(fakeLayout(), [block(3, { source: undefined })], 60);
  assert.equal(plain.sources.size, 0);
  // Its bar and the `(no output)` row it needs to say something are still rendered.
  assert.equal(plain.total, 4);
});
