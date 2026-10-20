import { withRpcOrigin } from '@eko/chain';
import { loadRegistry } from '@eko/chain';
import type { Ctx } from '../app.js';
import { SecurityCollectors } from './security-collectors.js';
import { logger } from './logger.js';

/**
 * Return whether the shared meter is running with positive daily and session budgets. Pure status
 * check; subsequent requests remain subject to meter enforcement.
 */
export function securityBudgetOpen(meter: Ctx['chains']['meter']) {
  return !meter.isStopped && meter.config.dailyBudget > 0 && meter.config.sessionBudget > 0;
}

/**
 * Require worker role and return configured collectors using the shared metered client and
 * accepted registry binding. Return undefined if all collectors are disabled; invalid registry
 * wiring rejects. Construction starts no polling; the dispatcher owns lifecycle and lease.
 */
export function workerSecurityCollectors(ctx: Ctx) {
  if (ctx.cfg.APP_ROLE !== 'worker') throw new Error('Security collectors require worker role');
  const config = ctx.cfg.SECURITY_COLLECTORS;
  if (!config.registry && !config.wallets && !config.reference && !config.gas) return undefined;
  const registry = loadRegistry();
  const accepted = registry.addressOf('ours.receiptsRegistry');
  const zero = `0x${'0'.repeat(40)}` as const;
  const client = ctx.chains.get('robinhood-mainnet','worker.security_collectors');
  const collectors = new SecurityCollectors(ctx.dbh.chain, {
    request: (method, params) => withRpcOrigin('server.security_worker.rawL28',()=>client.request({ method, params } as never)),
  }, config, {
    // An unset or mismatched manifest does not authorize a different registry scan.
    registry: accepted && accepted.toLowerCase() === ctx.cfg.RECEIPTS_REGISTRY_ADDRESS.toLowerCase() ? accepted.toLowerCase() as `0x${string}` : zero,
    burn: ctx.cfg.BURN_WALLET_ADDRESS.toLowerCase() as `0x${string}`,
    published: [ctx.cfg.DEV_FEE_WALLET.toLowerCase() as `0x${string}`, ctx.cfg.BURN_WALLET_ADDRESS.toLowerCase() as `0x${string}`],
    weth: registry.requireAddress('tokens.WETH').toLowerCase() as `0x${string}`,
    usdg: registry.requireAddress('tokens.USDG').toLowerCase() as `0x${string}`,
  }, input => ctx.monitoring.record(input), collector => logger.warn({ collector }, 'security_collector_unavailable'),
  () => securityBudgetOpen(ctx.chains.meter),
  () => logger.warn('security_wallet_unknown_token_observation'));
  return collectors;
}
