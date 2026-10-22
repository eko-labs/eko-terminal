import { createHash } from 'node:crypto';
import { compactGuardVerdict, type ScanResult } from '@eko/shared';

/**
 * Project a scan into bounded Guard share fields, retaining unavailable exit cost and incomplete
 * flow status. Pure projection; no names, provider prose or price forecast is generated.
 */
export function farcasterCard(result: ScanResult) {
  const view = compactGuardVerdict({ version: 2, assessment: result.guardCard?.verdict ?? null });
  const agent = result.guardCard?.flow.agentPct;
  return { title: 'Buyer risk snapshot', label: [view.label, view.mode].filter(Boolean).join(' · '), gap: view.gap,
    details: [view.lines[0] ?? 'Top playbook: unavailable',
      `Agent share (beta): ${agent?.status === 'observed' && agent.coverage.complete ? `${agent.value}%` : 'unavailable'}`,
      // TODO(spec): §15.6 does not select a Guard 2 route/account quote; do not combine quote snapshots.
      'Exit cost: unavailable in this share projection'],
    block: result.guardCard?.verdict?.cursor.blockNumber ?? 'unavailable', receipt: view.receiptId ?? 'pending' };
}
export interface FarcasterImage { png: Uint8Array; contentHash: string; imageHash: string; width: number; height: number }
/** Structural OgRenderer.render interface; no dependency on its rasterizer implementation. */
export interface FarcasterRenderer {
  render(card: ReturnType<typeof farcasterCard>, format: 'reply'): Promise<FarcasterImage>;
}
/**
 * Check image dimensions, PNG signature/IHDR and SHA-256 image hash against the supplied bytes.
 * Return a boolean; this structural check does not decode all PNG chunks or authenticate content
 * origin.
 */
export function validFarcasterImage(image: FarcasterImage): boolean {
  const bytes = Buffer.from(image.png);
  return image.width === 1200 && image.height === 675 && /^[0-9a-f]{64}$/.test(image.contentHash) &&
    image.imageHash === createHash('sha256').update(bytes).digest('hex') && bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) === 1200 && bytes.readUInt32BE(20) === 675;
}
/**
 * Return a renderer adapter for ready Guard scans; missing cards return null. Require a valid
 * 1200x675 reply PNG; injected renderer/validation failures reject. No upload or platform client
 * starts.
 */
export function farcasterImages(renderer: FarcasterRenderer) {
  return async (result: ScanResult): Promise<FarcasterImage | null> => {
    if (result.status !== 'ready' || !result.guardCard) return null;
    const image = await renderer.render(farcasterCard(result), 'reply');
    if (!validFarcasterImage(image)) throw new Error('Invalid Farcaster reply image');
    return image;
  };
}
