/** Render-probe run as a child process by `tests/controller/perf-measures.test.ts`.
 *
 * Kept as a fixture because `--eval` bypasses tsx's path mapping and cannot resolve the `.tsx`
 * sources. The render count arrives through `PERF_PROBE_RENDERS` so the test owns the scale.
 */
import { performance } from 'node:perf_hooks';
import { mount } from '../../src/ui/mount.tsx';
import { Controller } from '../../src/controller/controller.ts';

const renders = Number(process.env.PERF_PROBE_RENDERS ?? '200');
const controller = new Controller('http://127.0.0.1:1', undefined, undefined);
for (let i = 0; i < renders; i++) {
  const app = mount(controller);
  app.unmount();
}
// React writes act() guidance to this stream as well, so the count carries its own marker.
process.stdout.write(`PERF_PROBE_MEASURES=${performance.getEntriesByType('measure').length}\n`);
