import { summonEnabled, type SummonFlags, type FarcasterReply } from './handler.js';
import { CastHashSchema, FidSchema } from './verify.js';

export const FARCASTER_TRANSPORT_ENABLED = false;
export interface NeynarCastRequest {
  signer_uuid: string; parent: string; parent_author_fid: number; idem: string;
  text: string; embeds: [{ url: string }, { url: string }];
}
/**
 * Validate parent identifiers and HTTPS image/record links and project a managed-signer cast
 * request with idempotency key. Pure request construction; invalid input throws and no publish
 * occurs.
 */
export function neynarCastRequest(reply: FarcasterReply, imageUrl: string): NeynarCastRequest {
  const parent = CastHashSchema.parse(reply.parent);
  FidSchema.parse(reply.parentAuthorFid);
  const url = new URL(imageUrl), record = new URL(reply.recordLink);
  for (const link of [url, record]) {
    if (link.protocol !== 'https:' || link.username || link.password || link.hash) throw new Error('Invalid Farcaster embed URL');
  }
  return { signer_uuid: reply.signerUuid, parent, parent_author_fid: reply.parentAuthorFid,
    idem: reply.idem, text: reply.text, embeds: [{ url: url.href }, { url: record.href }] };
}
/** No client construction, credentials, custody keys, account setup or HTTP calls. */
export function neynarSend(client: { publishCast(input: NeynarCastRequest): Promise<unknown> },
  imageUrl: (reply: FarcasterReply) => Promise<string>, flags?: SummonFlags) {
  return async (reply: FarcasterReply) => {
    if (!await summonEnabled(flags)) throw new Error('Farcaster summon flag is off');
    if (!FARCASTER_TRANSPORT_ENABLED) throw new Error('Farcaster transport is disabled');
    // Future accepted asset storage must host this exact PNG. No image upload happens while dark.
    const request = neynarCastRequest(reply, await imageUrl(reply));
    if (!await summonEnabled(flags)) throw new Error('Farcaster summon flag is off');
    await client.publishCast(request);
  };
}
