/** Billing estimates with explicit coverage, calendar and unknown-price indicators. */
import { useTheme } from '../theme/index.ts';
import { Box, Text } from 'ink';
import { costText } from '../status/model.ts';
import type { CostTotal, Coverage } from '../../contracts.ts';
import { safeText } from '../../text.ts';

/** One formatted cost line: what to show, and how exact it is. */
export interface CostLine { text: string; unknown: number; records: number }

/** The billing panel's plain input, assembled by the composition root. */
export interface CostSource {
  session?: CostLine;
  today: CostLine;
  scanning: boolean;
  coverage: Coverage;
  scannedAt?: number;
  customPrices: boolean;
  error?: string;
  missing: readonly string[];
}

/** Render cached totals while the independent HTTP cost scan refreshes.
 * @param source - Plain billing summary, absent when this run has no ledger.
 * @returns Billing panel, including unpriced models and refresh errors.
 */
export function CostPanel({ source }: { source?: CostSource }) {
  const theme = useTheme();
  const costs = source;
  if (!costs) return <Text>Cost tracking is unavailable</Text>;
  const rows = [['Session', costs.session], ['Today', costs.today]] as const;
  return <Box flexDirection="column" borderStyle="single" paddingX={1}>
    <Text bold>Cost · CNY estimate · Asia/Shanghai · /cost closes</Text>
    {rows.map(([label, total]) => <Text key={label}>{label}: {total ? `${total.text} · ${total.unknown} unpriced / ${total.records} requests` : '?'}</Text>)}
    <Text dimColor>{costs.scanning ? 'Refreshing all visible sessions…'
      : costs.coverage === 'partial' ? 'Partial totals · awaiting a complete scan'
      : costs.scannedAt ? `Last refresh: ${new Date(costs.scannedAt).toISOString()}`
      : 'Cached totals from the previous run'}</Text>
    {costs.customPrices && <Text color={theme.colors.context}>Rates come from prices.json, not the shipped table.</Text>}
    <Text dimColor>Recorded settlement time determines tariff; * means a subtotal is not exact. Provider invoices are authoritative.</Text>
    {costs.error && <Text color={theme.colors.context}>Partial totals: {safeText(costs.error)}</Text>}
    {costs.missing.slice(0, 6).map(reason => <Text key={reason} color={theme.colors.context}>{safeText(reason)}</Text>)}
  </Box>;
}
