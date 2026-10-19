import { EntitlementsSchema, type PublicConfig } from '@eko/shared';
import type { Config } from '../config.js';

type LaunchConfig = Pick<Config, 'TIERS_ACTIVE_FROM' | 'FEE_ACTIVE_FROM' | 'LAUNCH_WEEK_AGENT_LIMIT'>;
/**
 * Project configured tier/fee activation timestamps at the supplied clock, prioritizing tiers.
 * Pure configuration read with no authentication or I/O; assumes validated configuration and
 * performs no additional date validation.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
 */
export function phaseAt(cfg: LaunchConfig, now: number): PublicConfig['phase'] {
  if (cfg.TIERS_ACTIVE_FROM && now >= Date.parse(cfg.TIERS_ACTIVE_FROM)) return 'tiers';
  if (cfg.FEE_ACTIVE_FROM && now >= Date.parse(cfg.FEE_ACTIVE_FROM)) return 'token_live';
  return 'launch_week';
}

/** Shared account/MCP entitlement projection; no cookies or HTTP route dependencies. */
export class EntitlementsService {
  /**
   * Retain phase/quota configuration for account and MCP projection. Host-only construction; no
   * validation, account authentication or holdings acquisition occurs here.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  constructor(private cfg: LaunchConfig) {}
  /**
   * Project Listener entitlements, configured launch-week agent quota (zero if absent), phase fee
   * metadata and zero unimplemented runs. No per-account holdings/trial authorization occurs;
   * invalid projected data throws schema errors.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Agent ownership and key lifecycle invariants}
   */
  get(now = Date.now()) {
    const phase = phaseAt(this.cfg, now);
    // TODO(spec): Launch-week agent quotas are unset; expose an explicit configured
    // limit, or 0 (unavailable), never infer unlimited agents. Unshipped runs stay 0.
    // TODO(spec): Token tiers/trials require their own accepted implementation;
    // after TIERS_ACTIVE_FROM expose Listener only, with no trial activation.
    return EntitlementsSchema.parse({ tier: 'listener', feeBps: phase === 'launch_week' ? 0 : 50,
      limits: { agents: phase === 'tiers' ? 1 : this.cfg.LAUNCH_WEEK_AGENT_LIMIT ?? 0,
        deepResearchPerDay: 0, loopBacktestsPerDay: 0, realtime: phase !== 'tiers' } });
  }
}
