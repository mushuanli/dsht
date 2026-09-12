/** Cover the React-only filtering the render-measurement safety net relies on.
 *
 * The module reads `globalThis.performance`, so each case installs a stub timeline of that shape and
 * removes it afterwards. The point of these tests is the blast radius: a pass must remove React's
 * own entries and leave every other entry on the timeline alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearReactMeasures, measureCount, reactMeasureNames } from '../../src/controller/perf-measures.ts';

/** A stand-in for the global performance timeline holding the given measure names. */
function stubTimeline(names: string[]) {
  const live = new Set(names);
  const timeline = {
    live,
    getEntriesByType: (type: string) => type === 'measure' ? [...live].map(name => ({ name })) : [],
    // Bound through the closure: the real method is called detached from its receiver.
    clearMeasures: (name?: string) => { if (name === undefined) live.clear(); else live.delete(name); },
  };
  return timeline as unknown as Performance & { live: Set<string> };
}

/** Run a case against a stub global timeline, restoring the previous global even when it throws. */
function withTimeline<T>(names: string[], run: (timeline: Performance & { live: Set<string> }) => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const timeline = stubTimeline(names);
  Object.defineProperty(globalThis, 'performance', { value: timeline, configurable: true, writable: true });
  try { return run(timeline); }
  finally {
    if (previous === undefined) delete (globalThis as { performance?: unknown }).performance;
    else Object.defineProperty(globalThis, 'performance', previous);
  }
}

test('only React render measures are selected for clearing', () => {
  const selected = withTimeline(
    ['\u200bApp', '\u200bBox', 'Mount', 'Update', 'Mount', 'my-own-measure', 'Update Blocked', 'bundle-scan'],
    timeline => reactMeasureNames(timeline),
  );
  assert.deepEqual(selected.sort(), ['Mount', 'Update', 'Update Blocked', '\u200bApp', '\u200bBox'].sort());
});

test('an unrelated name containing a React word is left alone', () => {
  const selected = withTimeline(['Mount effects for the editor', 'Update panel', 'xUpdate'], timeline => reactMeasureNames(timeline));
  assert.deepEqual(selected, []);
});

test('a clearing pass removes React entries and preserves the rest', () => {
  const timeline = withTimeline(
    ['\u200bApp', 'Mount', 'my-own-measure', 'bundle-scan'],
    timeline => { const cleared = clearReactMeasures(); return { cleared, live: [...timeline.live] }; },
  );
  assert.equal(timeline.cleared, 2);
  assert.deepEqual(timeline.live.sort(), ['bundle-scan', 'my-own-measure']);
});

test('the reported count reflects the timeline after a clearing pass', () => {
  const timeline = withTimeline(['\u200bApp', 'Mount', 'my-own-measure'], () =>
    ({ cleared: clearReactMeasures(), count: measureCount() }));
  assert.equal(timeline.cleared, 2);
  assert.equal(timeline.count, 1);
});
