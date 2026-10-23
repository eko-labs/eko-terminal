import type { SensesReadService } from '../../server/src/read/senses.js';
import { ToolRegistry } from './tools.js';

/**
 * Register snapshot-only Senses tools with negotiated Guard version, entitlement delay and
 * playbook visibility. Census stays explicitly gated and receipt reads use the supplied verifier;
 * no simulation or acquisition starts. Host construction/duplicate registration failures throw;
 * invocation read/schema failures propagate through the transport envelope.
 */
export function registerReadTools(service: SensesReadService, registry = new ToolRegistry()) {
  return registry
    .register('coin_verdict', (input, ctx) => service.verdict(input.coin, input.version, ctx.delayedSec))
    .register('coin_card', (input, ctx) => service.card(input.coin, input.version, input.flowWindow, ctx.delayedSec))
    .register('playbook_match', (input, ctx) => service.playbooks(input.coin, input.minLevel, input.includeHistory, ctx.delayedSec),
      ctx => ctx.entitlements.tier !== 'listener' || ctx.entitlements.limits.realtime)
    .register('census_summary', () => service.census())
    .register('receipts_lookup', input => service.receipt(input.id));
}
