import { PublicConfigSchema, visibleDrops, type PublicConfig } from '@eko/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { FlagService } from '../../flags/service.js';
import { CONFIG_DEFAULTS } from './defaults.js';
import { DROP_DEMO_MANIFEST } from './drop-manifest.js';
import { TradeAccessService } from '../../exec/trade-access.js';
import type { AccountServices } from './account.js';

import { phaseAt } from '../../harness/entitlements.js';
export { phaseAt } from '../../harness/entitlements.js';

/**
 * Register public configuration projection with runtime live switch/cap and accepted targets.
 * Optional session wallet and demo overrides force private no-store caching and Vary: Cookie;
 * public config does not authorize execution. Schema/database/flag failures reject.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function configRoutes(app: FastifyInstance, cfg: Config, service: FlagService, access = new TradeAccessService(cfg, service, async () => undefined), accounts?: AccountServices) {
  app.get('/config', async (req, reply): Promise<PublicConfig> => {
    const flags = await service.all();
    // Evaluate public release state before any session-only demo flag overrides.
    const drops = visibleDrops(DROP_DEMO_MANIFEST, flags);
    for (const flag of req.demoSession?.flags ?? []) flags[flag] = true;
    // TODO(spec): Demo responses must bypass shared caches to keep session flags private.
    const wallet = accounts ? (await accounts.auth.fromToken(accounts.auth.readCookie(req)))?.walletAddress : undefined;
    reply.header('Cache-Control', req.demoSession || wallet ? 'private, no-store' : 'public, max-age=10');
    reply.header('Vary', [reply.getHeader('Vary'), 'Cookie'].filter(Boolean).join(', '));
    return PublicConfigSchema.parse({
      ...CONFIG_DEFAULTS,
      ...(cfg.BLUE_CHIP_ENABLED ? {blueChip:{minAgeDays:cfg.BLUE_CHIP_MIN_AGE_DAYS,minLiquidityUsd:cfg.BLUE_CHIP_MIN_LIQUIDITY_USD,minHolders:cfg.BLUE_CHIP_MIN_HOLDERS}} : {}),
      drops,
      phase: phaseAt(cfg, Date.now()),
      flags,
      trading: {
        liveEnabled: await access.liveEnabled(),
        maxTradeUsd: await access.cap(wallet),
        ...access.verifiedTargets(),
      },
      contracts: { receiptsRegistry: cfg.RECEIPTS_REGISTRY_ADDRESS },
      wallets: { burn: cfg.BURN_WALLET_ADDRESS, dev: cfg.DEV_FEE_WALLET },
    });
  });
}
