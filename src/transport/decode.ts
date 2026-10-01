/**
 * Optional readers for host values that may be absent or of another JSON type.
 *
 * The strict decoders in `dsh-contract.ts` throw when a *structured* result is unreadable, because a
 * caller would otherwise act on a value it never received. These readers are the other posture: they
 * are for the fields where a host may legitimately send nothing — a projection a deployment does not
 * publish, a list section an older host omits, a display field that is a string or a null — and answer
 * `undefined` for "not this shape" instead of failing the frame.
 *
 * Each function is named for what it accepts, not for how it is used, so a call site reads as the
 * question it asks: `entriesOf` for an object's entries, `arrayOf` for rows, `optionalX` for one value.
 */
import { object, type Json, type ObjectValue } from '../json.ts';

/** Read a possibly-absent string without turning protocol drift into a throw. */
export function optionalString(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Read a possibly-absent finite number. */
export function optionalNumber(value: Json | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read a possibly-absent non-negative count, which a projection may publish as a float. */
export function optionalCount(value: Json | undefined): number | undefined {
  const count = optionalNumber(value);
  return count === undefined || count < 0 ? undefined : count;
}

/** Read an optional nested object, or undefined when the host sent something else. */
export function optionalObject(value: Json | undefined): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
}

/** Read a possibly-absent object as its entries, so a missing section is an empty map rather than a throw. */
export function entriesOf(value: Json | undefined): [string, Json][] {
  return value === undefined ? [] : Object.entries(object(value));
}

/** Read a possibly-absent array as rows, skipping a value of another shape. */
export function arrayOf(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}
