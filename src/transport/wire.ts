/** The wire's decoding surface.
 *
 * The JSON shapes, their strict readers and the displayable error text are dependency-free leaves
 * (`src/json.ts`, `src/text.ts`), so the UI can name the same types without importing the transport
 * domain. This module re-exports them as the wire-facing API the features already use.
 */
export type { Json, ObjectValue } from '../json.ts';
export { array, object, string } from '../json.ts';
export { errorText, safeText } from '../text.ts';
