/** Unambiguous slash-command target resolution and host title projection. */
import { string, type ObjectValue } from '../json.ts';
import { safeText } from '../text.ts';

/** Match an exact ID or name before a unique ID prefix; never choose an ambiguous target. */
export function resolveTarget(items: ObjectValue[], query: string, id: string, names: (item: ObjectValue) => string[]): ObjectValue {
  const target = query.replace(/^(["'])(.*)\1$/, '$2');
  const exactId = items.find(item => item[id] === target);
  if (exactId) return exactId;
  const exactNames = items.filter(item => names(item).includes(target));
  const matches = exactNames.length ? exactNames : items.filter(item => string(item[id]).startsWith(target));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Ambiguous target: ${target}. Use a full ID.`);
  throw new Error(`Target not found: ${target}`);
}
