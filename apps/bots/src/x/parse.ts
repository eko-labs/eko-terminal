import { z } from 'zod';

// Keep snowflakes as decimal strings: Number would lose tweet-id precision.
export const XIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value) <= 9223372036854775807n);
export const MentionPageSchema = z.object({
  data: z.array(z.object({ id: XIdSchema, author_id: XIdSchema, text: z.string().max(4096) })).max(100).default([]),
  meta: z.object({ next_token: z.string().min(1).max(1024).optional() }).default({}),
});
export type XMention = z.infer<typeof MentionPageSchema>['data'][number];

/** Only an address or an explicit scan $TICKER summons a response; prose stays in memory. */
export function parseXMention(text: string): string | null {
  if (text.length > 4096) return null;
  const addresses = [...text.matchAll(/(?<![\w])0x[0-9a-fA-F]{40}(?![\w])/g)].map(m => m[0].toLowerCase());
  const tickers = [...text.matchAll(/(?<![\w])scan\s+(\$[a-zA-Z][a-zA-Z0-9_]{0,31})(?![\w])/gi)].map(m => m[1].toUpperCase());
  const targets = [...new Set([...addresses, ...tickers])];
  // TODO(spec): §16 does not select between multiple targets; ignore ambiguous summons.
  return targets.length === 1 ? targets[0] : null;
}
