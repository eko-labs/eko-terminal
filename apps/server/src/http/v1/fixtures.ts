import { z } from 'zod';
import { JournalEntrySchema, type FlagName } from '@eko/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { FlagService } from '../../flags/service.js';
import type { AuthService } from '../auth.js';
import { HarnessError } from '../../harness/service.js';
import { fixtureOwners, fixtureSchemas, neutralFixture, type FixtureKind, type FixtureProducers } from '../../fixtures/producers.js';
import { InputError, notFound, parse, sendError } from './helpers.js';

export function isolatedFixtureStorage(cfg: Config) {
  // TODO(spec): CA-27 does not designate dev storage. Admit only ephemeral
  // PGlite in an API process with execution and live ingestion disabled.
  return !cfg.DATABASE_URL && cfg.PGLITE_DIR === ':memory:' && cfg.APP_ROLE === 'api'
    && !cfg.RUN_WORKER && !cfg.LIVE_TRADING_ENABLED && cfg.MARKET_DATA_SOURCE === 'demo';
}
const gated: Partial<Record<FixtureKind, FlagName>> = { approval: 'approvals', burn: 'burn_board' };
export async function fixtureRoutes(app: FastifyInstance, cfg: Config, flags: FlagService,
  producers: FixtureProducers = {}, auth?: AuthService) {
  // Defense in depth, including callers that bypass loadConfig.
  if (!cfg.ENABLE_DEV_ROUTES || cfg.NODE_ENV === 'production') return;
  await app.register(async area => {
    area.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'private, no-store'); });
    area.setErrorHandler((error, _req, reply) => {
      if (error instanceof InputError) return sendError(reply, 'bad_request', 'Invalid synthetic fixture');
      if (error instanceof HarnessError) return sendError(reply, error.code, error.message);
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 403) return sendError(reply, 'forbidden', 'Forbidden');
      if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500)
        return sendError(reply, 'bad_request', 'Invalid synthetic fixture');
      // Fixture/journal data and raw writer errors never enter remote telemetry.
      return sendError(reply, 'internal_error', 'Fixture producer failed');
    });
    for (const kind of Object.keys(fixtureSchemas) as FixtureKind[]) {
      area.post(`/dev/fixtures/${kind}`, { bodyLimit: 64 * 1024 }, async (req, reply) => {
        const flag = gated[kind];
        // Demo flag overrides cannot authorize writes or expose disabled kinds.
        if (flag && !await flags.isOn(flag)) return notFound(reply);
        if (req.demoSession) return sendError(reply, 'forbidden', 'Demo sessions cannot write');
        if (!isolatedFixtureStorage(cfg)) return sendError(reply, 'forbidden', 'Fixtures require isolated ephemeral dev storage');
        const envelope = parse(z.object({ synthetic: z.literal(true), data: z.unknown() }).strict(), req.body);
        if (!neutralFixture(envelope.data)) return sendError(reply, 'bad_request', 'Use neutral synthetic fixture data');
        const input = parse<unknown>(fixtureSchemas[kind], envelope.data);
        // TODO(spec): FRONTEND §13 cites burn_engine, absent from the shared
        // FlagName union on this revision. Keep engine fixtures unavailable.
        if (kind === 'burn' && fixtureSchemas.burn.parse(input).kind === 'engine') return notFound(reply);
        const producer = producers[kind];
        if (!producer || producer.owner !== fixtureOwners[kind] || producer.storage !== 'isolated-dev') {
          // TODO(spec): CA-27 has no missing-capability error code. Reuse the
          // shared unavailable status (503) and name the missing producer.
          return sendError(reply, 'sim_unavailable', `Fixture producer capability is unavailable: ${kind} (${fixtureOwners[kind]})`);
        }
        let accountId: string | undefined;
        if (kind === 'journal' || kind === 'approval' || kind === 'order') {
          if (!auth) return sendError(reply, 'sim_unavailable', 'Fixture owner capability is unavailable');
          auth.originFor(req, true);
          const account = await auth.fromToken(auth.readCookie(req));
          if (!account || account.kind !== 'wallet') return sendError(reply, 'wallet_auth_required', 'Verify your wallet to inject owned fixtures');
          accountId = account.id;
        }
        // The keyed registry preserves input/output correlation at registration;
        // iteration over heterogeneous schemas erases it here only.
        const data = await (producer.inject as (input: unknown, accountId?: string) => Promise<unknown>)(input, accountId);
        const output = (kind === 'journal' ? JournalEntrySchema : fixtureSchemas[kind]).parse(data);
        return { synthetic: true, kind, data: output };
      });
    }
  });
}
