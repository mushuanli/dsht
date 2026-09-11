/** The only module that touches Ink's renderer; the CLI mounts the interface through it. */
import { render } from 'ink';
import { App } from './app.tsx';
import type { Controller } from '../controller/index.ts';

/** Render the application and return the Ink instance that owns its lifetime.
 * @param controller - Application controller.
 * @returns The mounted Ink instance.
 */
export function mount(controller: Controller) {
  return render(<App controller={controller} />, { exitOnCtrlC: false });
}
