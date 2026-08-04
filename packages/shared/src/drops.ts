import { z } from 'zod';
import { FLAG_STAGES, FlagNameSchema, type Flags } from './flags.js';

// Root-relative paths only: no remote hosts, redirects, escapes, queries or fragments.
export const DropVideoUrlSchema = z.string().regex(/^\/demos\/drops\/[a-z0-9][a-z0-9_-]*\.(mp4|webm)$/);
const DemoSchema = z.object({ videoUrl: DropVideoUrlSchema, recordedAt: z.iso.datetime({ offset: true }) });
const ReleaseSchema = z.object({
  version: z.string().trim().min(1),
  publishedAt: z.iso.datetime({ offset: true }),
  url: z.url().refine(value => /^https:\/\/[^/?#@]+(?:[/?#]|$)/i.test(value),
    'Release evidence must use an HTTPS URL without credentials'),
});

// TODO(spec): CA-9 omits demo assets, flag bindings and published-release evidence.
// Keep these additions optional for existing clients; evidence-free records never render.
export const PublicDropSchema = z.object({
  n: z.number(), date: z.string(), title: z.string(),
  status: z.enum(['hidden', 'demo', 'live']),
  demo: DemoSchema.optional(),
  requiredFlags: z.array(FlagNameSchema).nonempty().optional(),
  release: ReleaseSchema.optional(),
});
export const DropManifestEntrySchema = PublicDropSchema.extend({
  n: z.number().int().min(1).max(9),
  date: z.iso.date(),
  title: z.string().trim().min(1),
  demo: DemoSchema,
  requiredFlags: z.array(FlagNameSchema).nonempty(),
}).refine(drop => {
  const stageFlags: readonly string[] = FLAG_STAGES[`Drop ${drop.n}` as keyof typeof FLAG_STAGES] ?? [];
  return drop.requiredFlags.every(flag => stageFlags.includes(flag))
    && new Set(drop.requiredFlags).size === drop.requiredFlags.length;
}, 'Flags must belong to this Drop and be unique');
export type DropManifestEntry = z.infer<typeof DropManifestEntrySchema>;

/** Fail closed on missing demos; dates never promote a Drop to live. */
export function visibleDrops(records: readonly unknown[], flags: Partial<Flags>, now = Date.now()): DropManifestEntry[] {
  const result: DropManifestEntry[] = [];
  for (const record of records) {
    const parsed = DropManifestEntrySchema.safeParse(record);
    if (!parsed.success) continue;
    const drop = parsed.data;
    if (drop.status === 'hidden' || Date.parse(drop.demo.recordedAt) > now) continue;
    const live = drop.status === 'live' && drop.requiredFlags.every(flag => flags[flag] === true)
      && drop.release !== undefined && Date.parse(drop.release.publishedAt) <= now;
    result.push({ ...drop, status: live ? 'live' : 'demo' });
  }
  return result;
}
