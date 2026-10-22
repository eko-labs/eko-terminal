import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { AddressSchema, ScanResultSchema, compactGuardVerdict, type ScanResult } from '@eko/shared';
import { parseIntent } from '../telegram/parse.js';
import { NeynarWebhookVerifier, FidSchema } from './verify.js';
import { FarcasterStore } from './store.js';
import { validFarcasterImage, type FarcasterImage } from './images.js';

export interface SummonFlags { isOn(flag: 'summon_x'): Promise<boolean> }
/**
 * Read the shared summon flag, returning false when absent or failing. No platform call or
 * delivery occurs.
 */
export async function summonEnabled(flags?: SummonFlags): Promise<boolean> {
  try { return (await flags?.isOn('summon_x')) === true; } catch { return false; }
}
export interface FarcasterReply {
  botFid: number; signerUuid: string; parent: string; parentAuthorFid: number;
  idem: string; text: string; recordLink: string; image: FarcasterImage;
}
export interface FarcasterServices {
  scan(query: string): Promise<ScanResult>;
  image(result: ScanResult): Promise<FarcasterImage | null>;
  lookupSigner(signerUuid: string): Promise<unknown>;
}
const ApprovedSignerSchema = z.object({ signer_uuid: z.string().uuid(), status: z.literal('approved'), fid: FidSchema });

/** Prepared processing with injected fixture sends; the production route/adapter stay disabled. */
export class FarcasterHandler {
  readonly verifier: NeynarWebhookVerifier;
  private readonly origin: string;
  /**
   * Validate bot/signer configuration, identity-key length, webhook secret and HTTPS origin; wire
   * injected scan/image/signer/send services. No production transport or listener starts.
   */
  constructor(readonly store: FarcasterStore, readonly services: FarcasterServices,
    private readonly send: (reply: FarcasterReply) => Promise<void>,
    private readonly config: { botFid: number; signerUuid: string; webhookSecret: string; identityKey: string; publicOrigin: string },
    private readonly flags?: SummonFlags) {
    FidSchema.parse(config.botFid); z.string().uuid().parse(config.signerUuid);
    if (config.identityKey.length < 32) throw new Error('Invalid Farcaster identity hashing key');
    this.verifier = new NeynarWebhookVerifier(config.webhookSecret);
    const url = new URL(config.publicOrigin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid Farcaster public origin');
    this.origin = url.origin;
  }
  /**
   * Verify the exact signed bytes, bound event shape and summon flag, then claim mentioned scan
   * casts under dedupe/rate limits. Require matching managed signer, target and validated image;
   * recheck the flag before injected delivery. Return finite states and persist bounded failures;
   * uncertain sends are not retried.
   */
  async receive(signature: unknown, raw: unknown): Promise<{ status: number; state: string }> {
    if (!this.verifier.valid(raw, signature)) return { status: 403, state: 'forbidden' };
    const parsed = this.verifier.parse(raw);
    if (!parsed?.success) return { status: 422, state: 'invalid_event' };
    if (!await summonEnabled(this.flags)) return { status: 503, state: 'flag_off' };
    const cast = parsed.data.data, botFid = this.config.botFid;
    if (cast.author.fid === botFid || !cast.mentioned_profiles.some(profile => profile.fid === botFid)) return { status: 200, state: 'ignored' };
    const intent = parseIntent(cast.text);
    // TODO(spec): §16 does not define multi-target or non-scan Farcaster replies; ignore them without a cast.
    if (intent.kind !== 'scan') return { status: 200, state: 'ignored' };
    const authorKey = createHmac('sha256', this.config.identityKey).update(`farcaster:${botFid}:${cast.author.fid}`).digest('hex');
    const claim = await this.store.claim(botFid, cast.hash, authorKey);
    if (claim !== 'claimed') return { status: 200, state: claim };
    try {
      const signer = ApprovedSignerSchema.parse(await this.services.lookupSigner(this.config.signerUuid));
      if (signer.fid !== botFid || signer.signer_uuid !== this.config.signerUuid) throw new Error('Managed signer mismatch');
      const result = ScanResultSchema.parse(await this.services.scan(intent.query));
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(result.id) || result.status !== 'ready' || !result.guardCard) throw new Error('Scan image unavailable');
      const coin = result.guardCard.identity.address, address = AddressSchema.safeParse(intent.query);
      if (address.success && address.data !== coin || result.card && result.card.identity.address !== coin ||
        result.guardCard.verdict && result.guardCard.verdict.coin !== coin) throw new Error('Scan target mismatch');
      const image = await this.services.image(result);
      if (!image || !validFarcasterImage(image)) throw new Error('Scan image unavailable');
      const view = compactGuardVerdict({ version: 2, assessment: result.guardCard.verdict });
      const reply: FarcasterReply = { botFid, signerUuid: this.config.signerUuid, parent: cast.hash, parentAuthorFid: cast.author.fid,
        idem: createHash('sha256').update(`farcaster:${botFid}:${cast.hash}`).digest('hex').slice(0, 16),
        text: [view.label, view.mode, view.gap, ...view.disclosures].filter(Boolean).join('\n'),
        recordLink: `${this.origin}/scan/${result.id}`, image };
      // Recheck immediately before delivery: a stop during scan/render also suppresses the send.
      if (!await summonEnabled(this.flags)) {
        await this.store.finish(botFid, cast.hash, 'flag_off');
        return { status: 503, state: 'flag_off' };
      }
      await this.send(reply);
      await this.store.finish(botFid, cast.hash, 'sent');
      return { status: 200, state: 'sent' };
    } catch {
      // Never persist/log provider errors, request prose or credentials. No uncertain-send retry.
      await this.store.finish(botFid, cast.hash, 'failed');
      return { status: 200, state: 'failed' };
    }
  }
}
