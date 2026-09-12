/** Drop the render measurements React's development build appends to the global performance timeline.
 *
 * `react-reconciler` emits one `performance.measure()` entry per rendered component when it resolves
 * to its development build, and Node keeps every entry for the life of the process because
 * `performance.clearMeasures()` is the only way to release them. Each entry also carries a
 * `detail.devtools.properties` payload describing the component's props, which is where the memory
 * actually goes: roughly 1.2 KB per render once the duplicated property names are counted.
 *
 * The production build emits no measurements at all, so `src/cli/index.ts` selects it and this
 * module is a safety net for `DSHT_REACT_DEV=1`, where the development build is deliberate.
 */

/** Zero-width space React prefixes to a component's own measure name; see `ReactFiberPerformanceTrack` in react-reconciler. */
const COMPONENT_PREFIX = '\u200b';

/** Measure names React passes as an explicit update trigger, or as the label for an errored or recovered boundary. */
const REACT_NAMES: readonly string[] = [
  'Update', 'Cascading Update', 'Update Blocked', 'Update Suspended', 'Mount', 'Unmount',
  'Reconnect', 'Disconnect', 'Recovered', 'Errored',
];

/** Constructors `performance` uses for invalid input, which a measurement library cannot survive. */
const PROGRAMMING_ERRORS = ['TypeError', 'RangeError', 'SyntaxError'];

/** The global performance timeline, when the runtime exposes one.
 * @returns The timeline, or undefined on a runtime without `performance` or `getEntriesByType`.
 */
function timeline(): Performance | undefined {
  const candidate = globalThis.performance;
  return typeof candidate?.getEntriesByType === 'function' ? candidate : undefined;
}

/** Measure names the current timeline holds that React created.
 *
 * A name only counts when it is exactly one of `REACT_NAMES` or carries React's zero-width prefix,
 * so entries an application or a library created under its own name are never selected.
 * @param performance - Timeline to read.
 * @returns Names React created, without duplicates.
 */
export function reactMeasureNames(performance: Performance): string[] {
  const names = new Set<string>();
  for (const entry of performance.getEntriesByType('measure')) {
    const name = entry.name;
    if (name.startsWith(COMPONENT_PREFIX)) names.add(name);
    else if (REACT_NAMES.includes(name)) names.add(name);
  }
  return [...names];
}

/** Remove React's render measurements, and only those, from the global performance timeline.
 *
 * Intended to run on the memory-sampling interval: the development build keeps appending, so one
 * pass only bounds the total instead of ending it. A failure is not worth propagating, because this
 * is a bounded diagnostic and a measurement library that rejects input should not stop the client.
 * @returns How many distinct measure names were cleared.
 */
export function clearReactMeasures(): number {
  const performance = timeline();
  if (performance === undefined) return 0;
  const names = reactMeasureNames(performance);
  for (const name of names) {
    try {
      performance.clearMeasures(name);
    } catch (error) {
      if (!PROGRAMMING_ERRORS.includes((error as { name?: string } | undefined)?.name ?? '')) throw error;
    }
  }
  return names.length;
}

/** How many measure entries the timeline currently holds.
 *
 * Recorded next to the heap counters so a memory log shows whether retained growth tracks the
 * render count. Entries cleared by `clearReactMeasures` leave the count at zero.
 * @returns Entry count, or undefined on a runtime without a readable timeline.
 */
export function measureCount(): number | undefined {
  const performance = timeline();
  return performance?.getEntriesByType('measure').length;
}
