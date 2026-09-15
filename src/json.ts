/** Plain JSON shapes and the strict readers for them.
 *
 * A dependency-free leaf shared by the wire, the features and the UI contract: the wire validates
 * what it decodes with these, and the UI reads the host summaries it is handed. Typing those
 * summaries per feature is what will eventually let the UI stop reading raw objects.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };

/** Require an object from a decoded wire message. */
export function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object from the server');
  }
  return value as ObjectValue;
}

/** Require a string field rather than silently accepting protocol drift. */
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string from the server');
  return value;
}

/** Require an array field from the server. */
export function array(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new Error('Expected an array from the server');
  return value as Json[];
}
