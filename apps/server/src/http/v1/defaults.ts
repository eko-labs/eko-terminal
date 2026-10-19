import type { PublicConfig } from '@eko/shared';

export const CONFIG_DEFAULTS: Pick<PublicConfig, 'tiers' | 'drops' | 'burnBoard' | 'loops' | 'exampleScans'> = {
  // TODO(spec): Tier thresholds and entitlements are populated by the tiers task.
  tiers: [],
  // /config derives Drops from the recorded-demo manifest, never the roadmap.
  drops: [],
  // TODO(spec): Burn Board aggregates come from indexed burn data.
  burnBoard: { heroPctSupply: 0, heroUsd24h: 0 },
  // TODO(spec): Loop limits are configured by the Rule Lab task; no runs are supported yet.
  loops: { maxBars: 0, syncMaxBars: 0 },
  // TODO(spec): Verified example scan addresses are supplied by the scan task.
  exampleScans: [],
};
