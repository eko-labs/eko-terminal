import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ReviewStore, ReviewError } from '@eko/db';
import { Bytes32Schema, ReviewRoleSchema, ReviewPseudonymSchema, ReviewCaseInputSchema, ReviewLabelInputSchema, ReviewAdjudicationInputSchema } from '@eko/shared';
import type { AuthService } from './auth.js';
import { InputError, parse } from './v1/helpers.js';

/** Session-bound internal review endpoints. Provisioning does not grant an admin
 * score access: every read/export still requires an explicit case assignment. */
export async function reviewApiRoutes(app: FastifyInstance, store: ReviewStore, auth: Pick<AuthService, 'readCookie' | 'fromToken' | 'originFor'>) {
  await app.register(async api => {
    api.setErrorHandler((err, _req, reply) => {
      if (err instanceof ReviewError) return reply.status(err.statusCode).send({ error: 'review_error', message: err.message });
      if (err instanceof InputError) return reply.status(400).send({ error: 'bad_request', message: err.message });
      const e = err as Error & { statusCode?: number };
      if (e.statusCode === 401 || e.statusCode === 403) return reply.status(e.statusCode).send({ error: 'forbidden', message: e.message });
      api.log.error(err, 'Review API failed');
      return reply.status(500).send({ error: 'internal_error', message: 'Internal error' });
    });
    api.addHook('preHandler', async req => {
      req.account = await auth.fromToken(auth.readCookie(req));
      if (!req.account) throw Object.assign(new Error('Session required'), { statusCode: 401 });
      if (req.method !== 'GET') auth.originFor(req, true);
    });
    const account = (req: FastifyRequest) => req.account!.id;
    const admin = (req: FastifyRequest) => {
      if (req.account?.role !== 'admin') throw new ReviewError(403, 'Review coordinator role required');
    };
    const revision = (req: FastifyRequest) => parse(z.strictObject({ revisionId: Bytes32Schema }), req.params).revisionId;
    const caseId = (req: FastifyRequest) => parse(z.strictObject({ caseId: Bytes32Schema }), req.params).caseId;
    api.post('/cases', async req => { admin(req); return store.putCase(parse(ReviewCaseInputSchema, req.body)); });
    api.post('/cases/:caseId/assignments', async req => {
      admin(req);
      const body = parse(z.strictObject({ accountId: z.uuid(), pseudonym: ReviewPseudonymSchema, role: ReviewRoleSchema }), req.body);
      await store.assign(caseId(req), body.accountId, body.pseudonym, body.role);
      return { assigned: true };
    });
    api.get('/revisions/:revisionId/role', async (req, reply) => reply.type('application/json').send(JSON.stringify(ReviewRoleSchema.parse(await store.role(revision(req), account(req))))));
    api.get('/revisions/:revisionId', async req => store.view(revision(req), account(req)));
    api.post('/revisions/:revisionId/labels', async req => store.submit(revision(req), account(req), parse(ReviewLabelInputSchema, req.body)));
    api.post('/revisions/:revisionId/adjudications', async req => store.adjudicate(revision(req), account(req), parse(ReviewAdjudicationInputSchema, req.body)));
    api.get('/cases/:caseId/export', async req => store.export(caseId(req), account(req)));
  }, { prefix: '/v2/review' });
}
