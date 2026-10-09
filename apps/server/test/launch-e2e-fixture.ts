import { randomUUID } from 'node:crypto';
import { binary, publishReceipt } from '@eko/db';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../src/app.js';
import { PreflightService } from '../src/harness/preflight.js';
import { HarnessError } from '../src/harness/service.js';
import { sendError } from '../src/http/v1/helpers.js';
import type { TradeBackend } from '../src/exec/trades.js';
import { canonicalize } from '@eko/shared';
import { keccak256, stringToHex } from 'viem';

/** Persisted informational quote fixture. No executable adapter, probe or broadcaster. */
export function launchQuoteBackend(context: () => Ctx): TradeBackend {
  return {
    async quote(_owner, input, id) {
      const card = await context().reads.store.card(input.coin);
      return { checked: null, quote: { id, coin: input.coin, side: input.side, amountUsd: input.amountUsd,
        account: input.account, binding: false, amountIn: '100', valueWei: '0', networkFeeUsd: 0,
        route: { venue: 'pons_curve', executable: false, linkOut: 'http://localhost/quote-only' },
        expectedOut: '0', minOut: '0', priceImpactBps: 0, buyTaxPct: 0, sellTaxPct: 0, exitCostPct: 0,
        fee: { bps: 0, usd: 0, destination: null }, approvals: [],
        guard: { decision: 'refuse', checks: [{ code: 'sim_unavailable', status: 'refuse', label: 'Sample quote: archive acquisition unavailable' }] },
        expiresAt: new Date(Date.now() + 15000).toISOString(), asOfBlock: card?.freshness.block ?? 0 } };
    },
    async capture() { throw new Error('No executable launch fixture'); },
    probe: { async observe() { throw new Error('No executable launch fixture'); } },
  };
}

/** Only registered by the isolated Playwright server, never by the application. */
export async function launchE2eFixture(app: FastifyInstance, ctx: Ctx) {
  if (ctx.cfg.PGLITE_DIR !== ':memory:' || ctx.cfg.RUN_WORKER || ctx.cfg.LIVE_TRADING_ENABLED)
    throw new Error('Launch fixture requires ephemeral storage and disabled execution');
  const card = (await ctx.dbh.chain.sql.query<{ data: import('@eko/shared').CoinCard }>(
    'SELECT data FROM coin_card_latest ORDER BY coin LIMIT 1')).rows[0]!.data;
  const receiptId = 'sample-launch-receipt';
  // Synthetic screening snapshot, never evidence of current Treasury coverage.
  await ctx.dbh.chain.sql.query('INSERT INTO ofac_sdn(digest,refreshed_at,published_at,record_count,addresses) VALUES($1,$2,$2,1,$3)',
    ['sample-launch-sdn', new Date(), ['0x000000000000000000000000000000000000dead']]);
  const payload = { schemaVersion: 'public-receipt-1' as const, canonicalization: 'jcs-rfc8785/v1' as const,
    receiptId, revisionId: receiptId, chainId: 4663 as const, coin: card.identity.address, kind: 'forecast' as const,
    recordedAt: new Date().toISOString(), modelIds: ['sample-model'], personaSetVersion: 'sample-personas',
    cardSchemaVersion: 'sample-card', rulesVersion: 'sample-rules', outputSchemaVersion: 'forecast-1',
    snapshotHash: keccak256(stringToHex(canonicalize({ sample: 1 }))), deterministicInput: { sample: 1 }, decision: { probability: 0.25 },
    window: { kind: 'forecast' as const, startsAt: 'commit_block' as const, durationSec: 3600 }, supersedes: null, reorgOf: null };
  await publishReceipt(ctx.dbh.chain, 'fixture', payload);
  const preflight = new PreflightService(ctx.dbh.chain, ctx.journal);
  await app.register(async area => {
    area.setErrorHandler((error, _req, reply) => error instanceof HarnessError
      ? sendError(reply, error.code, error.message) : sendError(reply, 'bad_request', 'Invalid launch fixture request'));
    area.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (req.method !== 'GET') ctx.auth.originFor(req, true);
    });
    const owner = async (req: import('fastify').FastifyRequest) => {
      const account = await ctx.auth.fromToken(ctx.auth.readCookie(req));
      if (account?.kind !== 'wallet') throw new HarnessError('wallet_auth_required', 'Verify the sample wallet');
      return account;
    };
    area.get('/v1/e2e/candidate', async () => ({ coin: card.identity.address, symbol: card.identity.symbol.text, receiptId, payload,
      candidate: process.env.E2E_CANDIDATE_REVISION ?? 'unspecified', node: process.version,
      server: 'read-e2e-server + launch-e2e-fixture', storage: 'isolated in-memory PGlite', liveEnabled: false }));
    area.post('/v1/e2e/holdings', async req => {
      const account = await owner(req);
      // Real indexed candidates; balance acquisition is unavailable without archive RPC.
      await ctx.dbh.chain.sql.query('UPDATE tokens SET decimals=18 WHERE address=$1', [binary(card.identity.address)]);
      await ctx.dbh.chain.sql.query(`INSERT INTO balances(token,holder,amount,last_block)
        VALUES($1,$2,1200000000000000000000,$3) ON CONFLICT(token,holder) DO NOTHING`,
      [binary(card.identity.address), binary(account.walletAddress!), card.freshness.block]);
      return { coin: card.identity.address };
    });
    area.post('/v1/e2e/preflight', async req => {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const identity = await ctx.harness.authenticate(bearer);
      if (!identity) throw new HarnessError('unauthorized', 'Sample agent key required');
      return preflight.run({ accountId: identity.accountId, agentId: identity.agent.id }, req.body);
    });
    area.post('/v1/e2e/alert', async req => {
      await owner(req);
      const verdict = { ...card.verdict, level: 'monitor' as const };
      await ctx.dbh.chain.sql.query('INSERT INTO read_feed(id,coin,block,kind,data) VALUES($1,$2,$3,$4,$5)',
        [`sample-alert:${randomUUID()}`, binary(card.identity.address), card.freshness.block, 'verdict', verdict]);
      await ctx.alerts.poll();
      return { synthetic: true };
    });
    area.get('/v1/e2e/private-state/:id', async req => {
      const account = await owner(req), { id } = z.object({ id: z.uuid() }).parse(req.params);
      await ctx.harness.detail(account.id, id);
      const rows = (await ctx.dbh.chain.sql.query<{ ciphertext: Uint8Array }>(
        'SELECT ciphertext FROM harness_journal WHERE agent_id=$1 AND account_id=$2', [id, account.id])).rows;
      // Report properties only; neither encryption keys nor ciphertext leave the server.
      return { encryptedRows: rows.length, containsPlaintext: rows.some(row => Buffer.from(row.ciphertext).includes(Buffer.from('sample-order'))) };
    });
  });
}
