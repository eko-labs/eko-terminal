import { FlagNameSchema, type FlagName } from '@eko/shared';

/**
 * Features turned on for the live site, from EKO_FLAGS: flag names separated by commas or spaces, such as
 * "leaderboards,referrals" ("none" or empty for none). Names that are not flags are skipped and returned so they can
 * be logged. A flag only shows a feature's pages; the feature's own code still has to be merged and deployed first.
 */
export function parseFlags(raw: string | undefined): { on: Set<FlagName>; unknown: string[] } {
  const on = new Set<FlagName>(), unknown: string[] = [];
  for (const name of (raw ?? '').split(/[\s,]+/).map(s => s.trim()).filter(s => s && s !== 'none')) {
    const flag = FlagNameSchema.safeParse(name);
    if (flag.success) on.add(flag.data); else unknown.push(name);
  }
  return { on, unknown };
}
