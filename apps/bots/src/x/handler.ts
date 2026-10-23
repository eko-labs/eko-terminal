import { z } from 'zod';
import { AddressSchema, ScanResultSchema, compactGuardVerdict, DYOR, type ScanResult } from '@eko/shared';
import type { OgRenderer, ShareCard } from '@eko/og-renderer';
import { MentionPageSchema, parseXMention, type XMention } from './parse.js';
import { XStore } from './store.js';
import { disabledXTransport, XPlatformError, type XTransport } from './transport.js';

export type XFlag = (flag: 'summon_x' | 'burn_board') => Promise<boolean>;
const off: XFlag = async () => false;
export interface XServices { scan(query: string): Promise<ScanResult>; renderer: Pick<OgRenderer, 'render'> }
const mediaId = z.string().regex(/^[1-9][0-9]{0,24}$/);
function projection(result: ScanResult, query: string): { text: string; card: ShareCard } | null {
  const c = result.guardCard;
  if (result.status !== 'ready' || !c) return null;
  const address = AddressSchema.safeParse(query);
  if ((address.success && address.data !== c.identity.address) || (c.verdict && c.verdict.coin !== c.identity.address) ||
    (result.card && result.card.identity.address !== c.identity.address)) throw new Error('X scan target mismatch');
  const view = compactGuardVerdict({ version: 2, assessment: c.verdict });
  const flow = c.flow.agentPct;
  // TODO(spec): §15.6 does not select a Guard 2 exit quote; use unavailable, matching task 111.
  const card: ShareCard = { title: 'Buyer risk snapshot', label: [view.label, view.mode].filter(Boolean).join(' · '),
    gap: view.gap, details: [view.lines[0] ?? 'Top playbook: unavailable',
      `Agent share (beta): ${flow.status === 'observed' && flow.coverage.complete ? `${Number(flow.value).toFixed(1)}%` : 'unavailable'}`,
      'Exit cost: unavailable in this share projection'], block: c.verdict?.cursor.blockNumber ?? 'unavailable',
    receipt: c.verdict?.receipt.id && /^[a-zA-Z0-9_:.-]{1,200}$/.test(c.verdict.receipt.id) ? c.verdict.receipt.id : 'unavailable' };
  // No source names, ticker, evidence paths, share URLs or freeform scan messages enter the post or image.
  return { card, text: ['EKO · Buyer risk snapshot', view.label, view.mode, DYOR].filter(Boolean).join('\n') };
}
function validPng(png: Uint8Array) {
  const bytes = Buffer.from(png);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== 1200 || bytes.readUInt32BE(20) !== 675) throw new Error('Invalid X card PNG');
}

/** One externally scheduled tick, never an automatically started poller or enabled deployment. */
export class XSummonBot {
  /**
   * Wire durable quota/lease store, injected scan/renderer and default-disabled platform
   * transport/flag. Host construction starts no automatic poller or deployment.
   */
  constructor(readonly store: XStore, private readonly services: XServices,
    private readonly transport: XTransport = disabledXTransport, private readonly flag: XFlag = off) {}
  private async enabled(owner: string) { return await this.flag('summon_x') && await this.store.allowed(owner); }
  /**
   * Run one flag-gated leased mention page with reserved reads, validated scans and bounded
   * replies, advancing the cursor after durable handling. Recheck flags/lease before platform
   * actions and release the lease; 401/403 permanently stop the store. Return finite states;
   * uncertain sends are not replayed.
   */
  async poll(): Promise<'disabled' | 'idle' | 'processed' | 'failed' | 'stopped'> {
    if (!await this.flag('summon_x')) return 'disabled';
    const lease = await this.store.beginPoll(); if (!lease) return 'idle';
    try {
      if (!await this.enabled(lease.owner)) return 'disabled';
      const page = MentionPageSchema.parse(await this.transport.mentions({ max_results: lease.reservedReads,
        ...(lease.cursor ? { since_id: lease.cursor } : {}), ...(lease.token ? { pagination_token: lease.token } : {}) }));
      if (page.data.length > lease.reservedReads) throw new Error('X page exceeded reserved read count');
      await this.store.settleReads(lease, page.data.length);
      // A cursor advances only after the complete descending paginated window has been durably handled.
      for (const mention of [...page.data].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)) {
        if (!await this.enabled(lease.owner)) return 'disabled';
        await this.receive(mention, lease.owner);
      }
      await this.store.finishPage(lease, page.data.map(m => m.id), page.meta.next_token ?? null);
      return 'processed';
    } catch (error) {
      if (error instanceof XPlatformError && (error.status === 401 || error.status === 403)) { await this.store.stop(); return 'stopped'; }
      return 'failed';
    } finally { await this.store.release(lease); }
  }
  private async receive(mention: XMention, owner: string) {
    const query = parseXMention(mention.text); if (!query) return;
    if (await this.store.claim(mention.id, mention.author_id) !== 'claimed') return;
    try {
      if (!await this.enabled(owner)) { await this.store.finish(mention.id, 'disabled'); return; }
      const content = projection(ScanResultSchema.parse(await this.services.scan(query)), query);
      if (!content) { await this.store.finish(mention.id, 'unavailable'); return; }
      const image = await this.services.renderer.render(content.card, 'reply'); validPng(image.png);
      if (!await this.enabled(owner)) { await this.store.finish(mention.id, 'disabled'); return; }
      const media = mediaId.parse((await this.transport.upload(image.png, 'image/png')).media_id);
      if (!await this.enabled(owner)) { await this.store.finish(mention.id, 'disabled'); return; }
      await this.transport.reply({ text: content.text, media_id: media, in_reply_to_tweet_id: mention.id });
      await this.store.finish(mention.id, 'sent');
    } catch (error) {
      await this.store.finish(mention.id, 'failed');
      if (error instanceof XPlatformError && (error.status === 401 || error.status === 403)) throw error;
      // An uncertain upload/reply is never automatically replayed; only a fixed state is persisted.
    }
  }
}

const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,35})(?:\.[0-9]{1,18})?$/);
const txHash = z.string().regex(/^0x[0-9a-f]{64}$/);
export const XConfirmedBurnSchema = z.strictObject({ status: z.literal('confirmed_under_policy'),
  buyTx: txHash, burnTx: txHash, ethSpent: decimal, tokensBurned: decimal,
  supplyPct: decimal.refine(value => Number(value) <= 100) });
export type XConfirmedBurn = z.infer<typeof XConfirmedBurnSchema>;
/** Prepared posting seam only. The accepted D0 collector/confirmation policy supplies this input later. */
export class XBurnPoster {
  /**
   * Wire injected renderer, durable quota/dedupe store and default-disabled transport/flag.
   * Construction performs no platform call or burn confirmation.
   */
  constructor(readonly store: XStore, private readonly renderer: Pick<OgRenderer, 'render'>,
    private readonly transport: XTransport = disabledXTransport, private readonly flag: XFlag = off) {}
  private async enabled() { return await this.flag('burn_board') && await this.store.allowed(); }
  /**
   * Require burn-board/store gates and a supplied confirmed-under-policy burn projection; reserve
   * spend/dedupe, render a validated PNG and recheck gates before upload/post. Return finite
   * completion states and stop on 401/403. Caller supplies accepted burn evidence; no burn
   * transaction or uncertain-send retry occurs.
   */
  async post(raw: XConfirmedBurn): Promise<'disabled' | 'limited_or_duplicate' | 'sent' | 'failed' | 'stopped'> {
    if (!await this.enabled()) return 'disabled';
    const burn = XConfirmedBurnSchema.parse(raw);
    if (!await this.store.claimBurn(burn.burnTx)) return 'limited_or_duplicate';
    try {
      const details = [`ETH spent: ${burn.ethSpent}`, `Tokens burned: ${burn.tokensBurned}`, `Supply burned: ${burn.supplyPct}%`];
      const text = ['EKO · Confirmed burn', ...details, `Buy: ${burn.buyTx}`, `Burn: ${burn.burnTx}`, 'Not financial advice.'].join('\n');
      if (text.length > 280) throw new Error('X burn text exceeds post limit');
      const image = await this.renderer.render({ title: 'Confirmed burn', label: 'Manual buy-and-burn', gap: 'Confirmed under policy',
        details, block: 'unavailable', receipt: 'unavailable' }, 'reply'); validPng(image.png);
      if (!await this.enabled()) { await this.store.finishBurn(burn.burnTx, 'disabled'); return 'disabled'; }
      const media = mediaId.parse((await this.transport.upload(image.png, 'image/png')).media_id);
      if (!await this.enabled()) { await this.store.finishBurn(burn.burnTx, 'disabled'); return 'disabled'; }
      await this.transport.post({ text, media_id: media }); await this.store.finishBurn(burn.burnTx, 'sent'); return 'sent';
    } catch (error) {
      await this.store.finishBurn(burn.burnTx, 'failed');
      if (error instanceof XPlatformError && (error.status === 401 || error.status === 403)) { await this.store.stop(); return 'stopped'; }
      return 'failed';
    }
  }
}
