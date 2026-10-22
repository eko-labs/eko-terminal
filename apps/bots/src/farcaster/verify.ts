import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const FARCASTER_BODY_LIMIT = 32768;
export const FidSchema = z.number().int().positive().max(2147483647);
export const CastHashSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
// Strip profiles, handles, custody addresses, embeds and reply envelopes before processing.
const MentionSchema = z.object({
  type: z.literal('cast.created'),
  data: z.object({ hash: CastHashSchema, author: z.object({ fid: FidSchema }),
    text: z.string().max(4096), mentioned_profiles: z.array(z.object({ fid: FidSchema })).max(100) }),
});

/** Neynar signs the exact request bytes, not parsed/re-serialized JSON. */
export class NeynarWebhookVerifier {
  /**
   * Require a webhook secret between 32 and 256 bytes. Host construction stores it only in memory
   * and performs no verification or listener startup.
   */
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 256) throw new Error('Invalid Neynar webhook secret configuration');
  }
  /**
   * Verify a bounded raw byte body and hex HMAC-SHA512 signature using constant-time comparison.
   * Invalid types, sizes or signatures return false; JSON parsing is separate.
   */
  valid(raw: unknown, signature: unknown): raw is Uint8Array {
    if (!(raw instanceof Uint8Array) || raw.length > FARCASTER_BODY_LIMIT ||
      typeof signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(signature)) return false;
    return timingSafeEqual(createHmac('sha512', this.secret).update(raw).digest(), Buffer.from(signature, 'hex'));
  }
  /**
   * Decode UTF-8 JSON into the bounded cast-created projection, stripping unrelated profile
   * fields. Return a schema result or null for decoding/JSON failure; caller must verify the exact
   * bytes first.
   */
  parse(raw: Uint8Array) {
    try { return MentionSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))); }
    catch { return null; }
  }
}
