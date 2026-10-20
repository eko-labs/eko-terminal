import { JournalConsentSchema, JournalEntrySchema } from '@eko/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth.js';
import type { JournalService } from '../../harness/journal.js';
import { HarnessError } from '../../harness/service.js';
import { parse, sendError } from './helpers.js';
const Params = z.object({ id: z.uuid() });
const Query = z.object({ cursor: z.uuid().optional(), kind: JournalEntrySchema.shape.kind.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export interface JournalServices { auth: AuthService; journal: JournalService }
/**
 * Register owner-only encrypted journal reads, explicit consent and destruction. Wallet sessions
 * are mandatory; mutations require allowed Origin and reject demos. Invalid
 * ownership/consent/key/cursor/storage state rejects; the group suppresses private operation error
 * details from remote reporting.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function journalRoutes(app: FastifyInstance, services: JournalServices) {
  const { auth, journal } = services;
  app.addHook('onRequest', async (_req,reply) => { reply.header('Cache-Control','private, no-store'); });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HarnessError) return sendError(reply,error.code,error.message);
    // This boundary deliberately never reports private operation errors remotely.
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 403) return sendError(reply,'forbidden','Forbidden');
    if (error instanceof Error && 'code' in error && error.code === 'bad_request') return sendError(reply,'bad_request','Invalid journal request');
    return sendError(reply,'internal_error','Journal storage is unavailable');
  });
  const owner = async (req: FastifyRequest) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if (req.demoSession) throw new HarnessError('forbidden','Demo sessions cannot write');
      auth.originFor(req,true);
    }
    const account = await auth.fromToken(auth.readCookie(req));
    if (!account || account.kind !== 'wallet') throw new HarnessError('wallet_auth_required','Verify your wallet to manage journal data.');
    return account.id;
  };
  app.get('/agents/:id/journal', async req => journal.page(await owner(req),parse(Params,req.params).id,parse(Query,req.query)));
  // TODO(spec): Journal consent has no frozen endpoint. Expose a separate,
  // owner-only boolean resource; never infer journal opt-in from tool usage.
  app.get('/me/journal-consent', async req => journal.consent(await owner(req)));
  app.put('/me/journal-consent', async req => journal.setConsent(await owner(req),parse(JournalConsentSchema,req.body).optedIn));
  app.delete('/me/data', async req => journal.deleteData(await owner(req)));
}
