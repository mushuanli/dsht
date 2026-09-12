/** Billing estimates with explicit coverage, calendar and unknown-price indicators. */
import { useTheme } from '../theme/index.ts';
import { Box, Text } from 'ink';
import { costText } from '../../cost/index.ts';
import type { Controller } from '../../controller/index.ts';
import { safeText } from '../../transport/wire.ts';

/** Render cached totals while the independent HTTP cost scan refreshes.
 * @param controller - Selected session and origin-scoped cost ledger.
 * @returns Billing panel, including unpriced models and refresh errors.
 */
export function CostPanel({ controller }: { controller: Controller }) {
  const theme = useTheme();
  const costs = controller.costs;
  if (!costs) return <Text>Cost tracking is unavailable</Text>;
  const id = controller.state.sessionId;
  const rows = [
    ['Session', id && costs.hasSession(id) ? costs.total(id) : undefined],
    ['Today', costs.total(undefined, 1)], ['3 days (today + previous 2)', costs.total(undefined, 3)],
  ] as const;
  return <Box flexDirection="column" borderStyle="single" paddingX={1}>
    <Text bold>Cost · CNY estimate · Asia/Shanghai · /cost closes</Text>
    {rows.map(([label, total]) => <Text key={label}>{label}: {total ? `${costText(total)} · ${total.unknown} unpriced${total.estimated ? ` · ${total.estimated} estimated` : ''} / ${total.records} requests` : '?'}</Text>)}
    <Text dimColor>{costs.scanning ? 'Refreshing all visible sessions…'
      : costs.coverage === 'partial' ? 'Partial totals · awaiting a complete scan'
      : costs.scannedAt ? `Last refresh: ${new Date(costs.scannedAt).toISOString()}`
      : 'Cached totals from the previous run'}</Text>
    {costs.customPrices && <Text color={theme.colors.context}>Rates come from prices.json, not the shipped table.</Text>}
    <Text dimColor>Recorded settlement time determines tariff; * means a subtotal is not exact. Provider invoices are authoritative.</Text>
    {costs.error && <Text color={theme.colors.context}>Partial totals: {safeText(costs.error)}</Text>}
    {costs.missing().slice(0, 6).map(reason => <Text key={reason} color={theme.colors.context}>{safeText(reason)}</Text>)}
  </Box>;
}
