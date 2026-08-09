import { z } from 'zod';
import { AddressSchema, LevelSchema, PlaybookIdSchema, UntrustedSchema } from './common.js';

/**
 * A deployer's record on Elysium (EKO's memory): its launches and its crew's (deployers paid by the same funder, when
 * that funder is not a hub), with each launch's strongest checks and what became of it at 1 h and 24 h. Launches
 * nobody traded have no outcome. Outcomes: rugged (price fell 90%+ from its peak while insiders sold), honeypot (could
 * not be sold), dumped (launch insiders sold over half within the first hour), survived.
 */
const VerdictLevelSchema = z.enum(['clear', 'info', 'monitor', 'danger', 'pending']);
export const LaunchOutcomeSchema = z.enum(['rugged', 'honeypot', 'dumped', 'survived']);
export const DeployerLaunchSchema = z.object({
  address: AddressSchema, deployer: AddressSchema, relation: z.enum(['deployer', 'crew']),
  name: UntrustedSchema, symbol: UntrustedSchema, createdAt: z.iso.datetime(), block: z.number().int().nonnegative(),
  swaps: z.number().int().nonnegative().nullable(),
  level: VerdictLevelSchema.nullable(), firstLevel: VerdictLevelSchema.nullable(),
  /** Checks that reached Monitor or Danger, strongest first. */
  flags: z.array(z.object({ id: PlaybookIdSchema, level: LevelSchema })),
  outcome1h: LaunchOutcomeSchema.nullable(), outcome24h: LaunchOutcomeSchema.nullable(),
  /** 'live': checked by EKO as it launched; 'replay': rebuilt later from its logs (no sell check). */
  source: z.enum(['live', 'replay']).nullable(),
});
export const DeployerHistorySchema = z.object({
  deployer: AddressSchema,
  funder: z.object({ address: AddressSchema, fundedAt: z.iso.datetime().nullable(), hub: z.boolean(), tx: z.string().nullable() }).nullable(),
  /** Traced and nobody paid it HYPE first (e.g. bridged in), or not traced yet. */
  funderStatus: z.enum(['traced', 'none', 'pending']),
  crew: z.object({ id: AddressSchema, deployers: z.array(AddressSchema) }).nullable(),
  summary: z.object({
    launches: z.number().int().nonnegative(), traded: z.number().int().nonnegative(), flagged: z.number().int().nonnegative(),
    outcomes: z.object({ rugged: z.number().int().nonnegative(), honeypot: z.number().int().nonnegative(), dumped: z.number().int().nonnegative(), survived: z.number().int().nonnegative() }),
    firstLaunchAt: z.iso.datetime().nullable(), lastLaunchAt: z.iso.datetime().nullable(),
  }),
  launches: z.array(DeployerLaunchSchema),
  /** Records start with Elysium's first Montra launch; outcomes need a day to settle. */
  coverage: z.object({ since: z.iso.datetime().nullable(), launchesThroughBlock: z.number().int().nonnegative() }),
});
export type DeployerLaunch = z.infer<typeof DeployerLaunchSchema>;
export type DeployerHistory = z.infer<typeof DeployerHistorySchema>;
