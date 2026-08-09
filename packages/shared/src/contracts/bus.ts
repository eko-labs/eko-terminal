import { z } from 'zod';
import { GuardBusTopicSchema } from './guard-storage.js';
// BACKEND §21.1. Payloads contain ids only; consumers read the owning table (§3.2).
export const BUS_TOPICS = [
  'chain.block', 'chain.reorg', 'swap', 'pair.created', 'liquidity', 'pons.exempt',
  'label.updated', 'card.updated', 'verdict.created', 'forecast.created', 'preflight.created',
  'approval.updated', 'order.updated', 'burn.event', 'pons.buyback', 'receipt.committed',
] as const;
export const BusTopicSchema = z.enum(BUS_TOPICS);
export type BusTopic = z.infer<typeof BusTopicSchema>;
/** NOTIFY takes an identifier. Dots require quoting, so use unquoted underscore identifiers.
 * https://www.postgresql.org/docs/16/sql-notify.html
 * These frozen topics map uniquely; all channels are below the 63-byte identifier limit.
 */
export function busChannel(topic: BusTopic | z.infer<typeof GuardBusTopicSchema>): string {
  return `eko_${z.union([BusTopicSchema, GuardBusTopicSchema]).parse(topic).replaceAll('.', '_')}`;
}
