/** Presentation helpers for the status and cost panels. */
import type { CostTotal } from '../../contracts.ts';

/** Render a cost total with a marker while any record behind it is unpriced.
 * @param total - Folded session or day total.
 * @returns The estimate, prefixed `~` because it is derived from usage, not an invoice.
 */
export function costText(total: CostTotal): string { return `~¥${total.amount.toFixed(4)}${total.unknown ? '*' : ''}`; }
