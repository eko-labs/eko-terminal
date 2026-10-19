import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { compactGuardVerdict, guardShareMetadata, GUARD_SHARE_TITLE, publicSharePath, publicShareOrigin, shareMetadata,
  shareHead, type ShareMeta, type Address, type CoinCard, type ScanResult, type GuardConsumerRequest, findingsFirst } from '@eko/shared';
import type { OgRenderer, ShareCard } from '@eko/og-renderer';
import type { ReceiptApiStore } from '@eko/db';
import type { Config } from '../config.js';
import type { ReadServices } from './v1/reads.js';
import type { BagsService } from '../read/bags.js';

export interface ShareReaders {
  scan: Pick<ReadServices['scan'], 'get'>;
  coins: Pick<ReadServices['coins'], 'card'>;
  bags: Pick<BagsService, 'publicReport'>;
  receipts: Pick<ReceiptApiStore, 'get'>;
}
const percent = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? `${value.toFixed(1)}%` : 'unavailable';
const playbook = (value: string | undefined) => value ? value.replaceAll('_', ' ') : 'No matching playbook';
const pending: GuardConsumerRequest = { version: 2, assessment: null };

function coinContent(result: ScanResult): { card: ShareCard; description: string } {
  const c = result.card, v2 = result.guardCard;
  const request: GuardConsumerRequest = v2 ? { version: 2, assessment: v2.verdict }
    : c?.verdict.guardV2 ? { version: 2, assessment: c.verdict.guardV2 } : pending;
  const view = compactGuardVerdict(request);
  // Never infer a rules version from a card schema version or invent a V2 assessment from V1.
  const legacy = !!c && request.version === 2 && request.assessment === null;
  // The grade from rule set 1.0.x is the live grade: it reads as the grade, with "no match" named as the site names it.
  const label = legacy ? ({ clear: 'NO FLAGS', monitor: 'MONITOR', danger: 'DANGER', pending: 'NOT FULLY CHECKED' } as const)[c!.verdict.level] : [view.label, view.mode].filter(Boolean).join(' · ');
  const exit = c?.meta?.tradeability;
  const flow = c?.meta?.flow;
  const flowAvailable = flow && !flow.unavailable && !flow.missing?.includes('agentPct') && !flow.coverageGaps?.[c!.flow.window];
  // TODO(spec): §15.6 does not select a Guard 2 route/account quote for the share headline.
  // Keep its exit cost unavailable rather than combine quotes or snapshots.
  const details = legacy ? [
    `Top playbook: ${playbook(findingsFirst(c!.verdict.playbooks)[0]?.id)}`,
    `Agent share${c!.flow.beta === false ? '' : ' (beta)'}: ${percent(flowAvailable ? c!.flow.agentPct : undefined)} · confidence ${percent(flowAvailable ? c!.flow.confidence : undefined)}`,
    `Exit cost ($1,000): ${percent(exit && !exit.unavailable && !exit.missing?.includes('exitCostPct') ? c!.tradeability.exitCostPct.usd1k : undefined)}`,
  ] : [
    // TODO(spec): Guard 2 has no playbook field; keep it unavailable rather than relabel reasons.
    `Top playbook: ${!v2 && c ? playbook(findingsFirst(c.verdict.playbooks)[0]?.id) : 'unavailable'}`,
    `Agent share (beta): ${percent(v2?.flow.agentPct.status === 'observed' && v2.flow.agentPct.coverage.complete ? Number(v2.flow.agentPct.value) : undefined)} · confidence unavailable`,
    'Exit cost: unavailable in this share projection',
  ];
  return { description: legacy ? `${label} · ${view.disclosures.join(' · ')}` : guardShareMetadata(request).description,
    card: { title: 'Buyer risk snapshot', name: v2?.identity.name.text ?? c?.identity.name.text,
      symbol: v2?.identity.symbol.text ?? c?.identity.symbol.text, label: result.status === 'ready' ? label : `Scan ${result.status} · ${view.label}`,
      gap: legacy ? c!.verdict.level === 'pending' ? 'Not fully checked · required checks pending' : 'Rule set 1.0.x · see the full scan' : view.gap,
      details, block: v2?.verdict?.cursor.blockNumber ?? (c ? String(c.verdict.asOfBlock) : 'unavailable'),
      receipt: v2?.verdict?.receipt.id ?? c?.verdict.receipt.id ?? 'pending' } };
}

export class ShareService {
  readonly origin: string;
  /**
   * Validate the public origin and wire public snapshot readers and optional renderer. Host
   * construction performs no private-account reads or rendering.
   */
  constructor(origin: string, private readonly readers: ShareReaders, private readonly renderer?: OgRenderer) {
    this.origin = publicShareOrigin(origin);
  }
  /**
   * Normalize an allowed public path and project scan/coin, explicitly shared bags, or receipt-
   * status metadata with its cache policy. Unknown/missing resources return null; reader failures
   * reject. No request account, private holdings or receipt payload is projected.
   */
  async content(rawPath: string): Promise<{ meta: ShareMeta; card?: ShareCard; cache: string } | null> {
    const path = publicSharePath(rawPath); if (!path) return null;
    const changing = 'public, max-age=0, must-revalidate';
    if (path.kind === 'scan' || path.kind === 'coin') {
      const result = path.kind === 'scan' ? await this.readers.scan.get(path.id)
        : await this.readers.coins.card(path.id as Address).then((card: CoinCard | null) => card ? { id: path.id, status: 'ready' as const, shareUrl: path.path, card } : undefined);
      if (!result) return null;
      const content = coinContent(result);
      return { meta: shareMetadata(this.origin, path, GUARD_SHARE_TITLE, content.description, !!this.renderer), card: content.card, cache: changing };
    }
    if (path.kind === 'bags') {
      // This is the ONLY bags reader used here. No request account, private holdings or live balances.
      const report = await this.readers.bags.publicReport(path.id); if (!report) return null;
      const count = `${report.summary.coins} coins · ${report.summary.flagged} flagged · ${report.summary.danger} danger`;
      return { meta: shareMetadata(this.origin, path, 'EKO · Shared bag report', count, !!this.renderer), cache: 'public, max-age=300',
        card: { title: 'Shared bag report', label: count, gap: 'Indexed candidates · shared snapshot · Agent share: unavailable (beta)', block: String(report.asOfBlock),
          // TODO(spec): CA-6 has no aggregate receipt ID; show unavailable rather than invent one.
          receipt: 'unavailable', details: report.holdings.length ? report.holdings.slice(0, 3).map(row =>
            `${row.coin.symbol.text} · ${row.coin.verdict.toUpperCase()} · ${row.status ?? 'unavailable'} · Top playbook: ${playbook(row.playbooks[0])} · Exit cost ($1,000): ${percent(row.exitCost1kPct ?? undefined)}`)
            : ['Verdict: unavailable · no shared holdings', 'Top playbook: unavailable', 'Exit cost: unavailable'] } };
    }
    const receipt = await this.readers.receipts.get(path.id); if (!receipt) return null;
    // Deliberately read only status, even for explicitly revealed public payloads.
    return { meta: shareMetadata(this.origin, path, 'EKO · Receipt verification', `Receipt ${receipt.status}`), cache: 'no-store' };
  }
  /**
   * Render the public snapshot card in share/reply format and retain its cache policy. Missing
   * card returns null; absent/busy/failed renderer rejects. No private readers are consulted.
   */
  async image(path: string, format: 'share' | 'reply') {
    const content = await this.content(path); if (!content?.card) return null;
    if (!this.renderer) throw new Error('og_renderer_unavailable');
    return { ...await this.renderer.render(content.card, format), cache: content.cache };
  }
}

/**
 * Apply cache, referrer, content-type, permissions and CSP headers from host configuration. Embed
 * paths allow framing; other paths deny it. Invalid configured origins reject; this function does
 * not authenticate requests.
 */
export function webHeaders(reply: FastifyReply, cfg: Config, cache: string, path: string) {
  const publicOrigins = cfg.origins.map(publicShareOrigin);
  const rpcOrigin = cfg.RPC_PUBLIC_HTTP_URL ? new URL(cfg.RPC_PUBLIC_HTTP_URL).origin : '';
  const sockets = publicOrigins.map(origin => origin.replace(/^http/, 'ws'));
  reply.header('Cache-Control', cache).header('Referrer-Policy', 'strict-origin-when-cross-origin')
    .header('X-Content-Type-Options', 'nosniff').header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    .header('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: ${publicOrigins.join(' ')}; font-src 'self'; connect-src 'self' ${[...publicOrigins, ...sockets, rpcOrigin].filter(Boolean).join(' ')}; media-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${path.startsWith('/embed/') ? '*' : "'none'"}${publicOrigins.every(o => o.startsWith('https:')) ? '; upgrade-insecure-requests' : ''}`)
    .header('Content-Security-Policy-Report-Only', "require-trusted-types-for 'script'");
}

/**
 * Register public metadata and scan/bag PNG routes with bounded paths/formats, cache headers and
 * image-hash ETags. Missing content returns 404; invalid formats return 400; renderer failures
 * return bounded 503 codes. Only ShareService public projections are read.
 */
export async function registerShareRoutes(app: FastifyInstance, shares: ShareService) {
  app.get('/v1/share-meta', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const path = (req.query as { path?: unknown }).path;
    const result = typeof path === 'string' && path.length <= 800 ? await shares.content(path) : null;
    return result?.meta ?? reply.code(404).send({ error: 'not_found' });
  });
  for (const kind of ['scan', 'bags'] as const) app.get(`/og/${kind}/:id.png`, async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const { id } = req.params as { id: string };
    const query = req.query as { format?: string };
    if (Object.keys(query).some(key => key !== 'format') || query.format && !['share', 'reply'].includes(query.format)) return reply.code(400).send({ error: 'bad_request' });
    const path = kind === 'scan' ? `/scan/${id}` : `/bags/r/${id}`;
    try {
      const result = await shares.image(path, query.format === 'reply' ? 'reply' : 'share');
      if (!result) return reply.code(404).send({ error: 'not_found' });
      const etag = `"${result.imageHash}"`;
      reply.header('Cache-Control', result.cache).header('ETag', etag).type('image/png');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return result.png;
    } catch (error) {
      const code = error instanceof Error && ['og_renderer_busy', 'og_renderer_timeout'].includes(error.message)
        ? error.message : 'og_renderer_unavailable';
      return reply.header('Retry-After', '1').code(503).send({ error: code });
    }
  });
}

/**
 * Read a host-selected SPA shell and require its head marker; return a responder injecting escaped
 * public share metadata and configured web headers. File/read/reader failures reject; unmatched
 * paths retain the default shell and private no-store policy.
 */
export async function spaDocument(file: string) {
  const html = await readFile(file, 'utf8');
  if (!html.includes('<!--eko:head-->')) throw new Error('Web head marker missing');
  // Replace the shell's default share tags while retaining its PWA head and SPA hooks.
  const shareHtml = html.replace('<title>EKO</title>', '')
    .replace(/<meta\b[^>]*(?:name="(?:description|twitter:[^"]+)"|property="og:[^"]+")[^>]*>/g, '');
  return async (rawUrl: string, reply: FastifyReply, cfg: Config, shares: ShareService) => {
    const path = rawUrl.split('?')[0];
    const content = await shares.content(path);
    webHeaders(reply, cfg, content?.cache ?? 'private, no-store', path);
    return reply.type('text/html; charset=utf-8').send(content
      ? shareHtml.replace('<!--eko:head-->', shareHead(content.meta))
      : html);
  };
}
