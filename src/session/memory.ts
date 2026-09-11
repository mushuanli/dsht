/** Soft budgets for reloadable semantic history, excluding active output and protected reading. */
export interface HistoryLimits { maxRecords: number; maxBytes: number }

/** Default balance: keep recent history in memory, reload older records through the host. */
export const DEFAULT_HISTORY_LIMITS: HistoryLimits = { maxRecords: 2000, maxBytes: 16 * 1024 * 1024 };

/** Parse optional CLI limits before opening a connection or writing application state.
 * @param records - Maximum retained semantic records, as a positive integer.
 * @param megabytes - Estimated semantic payload budget in MiB, as a positive integer.
 * @returns Validated history budgets, using defaults for omitted options.
 */
export function historyLimits(records?: string, megabytes?: string): HistoryLimits {
  const positive = (value: string | undefined, fallback: number, name: string) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
    return parsed;
  };
  const maxRecords = positive(records, DEFAULT_HISTORY_LIMITS.maxRecords, '--history-records');
  const maxBytes = positive(megabytes, DEFAULT_HISTORY_LIMITS.maxBytes / 1048576, '--history-mb') * 1048576;
  if (!Number.isSafeInteger(maxBytes)) throw new Error('--history-mb is too large');
  return { maxRecords, maxBytes };
}
