/** Unambiguous slash-command target resolution over host rows. */

/** Match an exact ID or name before a unique ID prefix; never choose an ambiguous target.
 *
 * Generic over the row: the caller names the identity field and the display names, so both the
 * workspace and session lists resolve targets from their own typed row without this leaf knowing
 * either shape.
 * @param items - Rows to search, in host order.
 * @param query - User text: an exact ID, an exact name, or a unique ID prefix.
 * @param id - Reads one row's identity.
 * @param names - Reads the names one row answers to.
 * @returns The single matching row.
 */
export function resolveTarget<T>(items: readonly T[], query: string, id: (item: T) => string, names: (item: T) => string[]): T {
  const target = query.replace(/^(["'])(.*)\1$/, '$2');
  const exactId = items.find(item => id(item) === target);
  if (exactId) return exactId;
  const exactNames = items.filter(item => names(item).includes(target));
  const matches = exactNames.length ? exactNames : items.filter(item => id(item).startsWith(target));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Ambiguous target: ${target}. Use a full ID.`);
  throw new Error(`Target not found: ${target}`);
}
