import { z } from 'zod';
import { AddressSchema, AgentSchema, PolicySchema, type Policy } from '@eko/shared';
import { applyPreset } from '@eko/policy';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { FlagService } from '../../flags/service.js';
import { HarnessError, HarnessService } from '../../harness/service.js';
import type { AuthService } from '../auth.js';
import { EntitlementsService } from './account.js';
import { notFound, parse, sendError } from './helpers.js';

const Params = z.object({ id: z.uuid() });
const KeyParams = Params.extend({ keyId: z.uuid() });
const Name = z.string().trim().min(1).max(120);
const Mode = PolicySchema.shape.mode;
const PolicyFields = PolicySchema.omit({ mode: true, killed: true, version: true, guardPolicyVersion: true }).partial().strict();
const validLimits = (policy: Partial<Policy>) => Object.entries(policy).every(([field, value]) =>
  typeof value !== 'number' || (Number.isFinite(value) && value >= 0 && (!['maxPositionPct', 'maxRoundTripCostPct'].includes(field) || value <= 100)));
const Overrides = PolicyFields.refine(validLimits, 'Limits must be nonnegative; percentages must be at most 100');
const Create = z.object({ name: Name, kind: AgentSchema.shape.kind, wallet: AddressSchema.optional(),
  preset: Mode, policy: Overrides.optional() }).strict();
const Patch = z.object({ name: Name.optional(), status: AgentSchema.shape.status.optional() }).strict()
  .refine(value => value.name !== undefined || value.status !== undefined, 'An update is required');
const SavePolicy = PolicySchema.strict().refine(validLimits, 'Limits must be nonnegative; percentages must be at most 100')
  .refine(policy => Number.isInteger(policy.version) && policy.version >= 1, 'Invalid policy version');

export interface AgentServices { auth: AuthService; harness: HarnessService }
/**
 * Register public presets and wallet-owner agent/policy/key APIs. All agent operations require
 * wallet sessions; mutations reject demos, require allowed Origin and applicable flags/quotas.
 * HarnessError becomes the shared error envelope; validation/storage failures propagate. No bearer
 * secret is returned by key-list reads.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function agentRoutes(app: FastifyInstance, cfg: Config, flags: FlagService, services: AgentServices) {
  const { auth, harness } = services, entitlements = new EntitlementsService(cfg);
  app.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'private, no-store'); });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HarnessError) return sendError(reply, error.code, error.message);
    throw error;
  });
  const owner = async (req: FastifyRequest) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.demoSession) throw new HarnessError('forbidden', 'Demo sessions cannot write');
      auth.originFor(req, true);
    }
    const account = await auth.fromToken(auth.readCookie(req));
    if (!account || account.kind !== 'wallet') throw new HarnessError('wallet_auth_required', 'Verify your wallet to manage agents.');
    return account.id;
  };
  const limit = () => entitlements.get().limits.agents;
  app.get('/policy-presets', async () => {
    // TODO(spec): The preset response envelope is not frozen; match the existing
    // Mission client: an array of named Policy objects, with API-owned version 1.
    return (['safe', 'balanced', 'degen'] as const).map(mode => ({ name: mode[0]!.toUpperCase() + mode.slice(1),
      policy: PolicySchema.parse(applyPreset({ mode, killed: false, version: 1 })) }));
  });
  app.get('/agents', async req => ({ agents: await harness.list(await owner(req)) }));
  app.post('/agents', async (req, reply) => {
    const accountId = await owner(req), input = parse(Create, req.body);
    return reply.code(201).send(await harness.create(accountId, input, limit()));
  });
  app.get('/agents/:id', async req => harness.detail(await owner(req), parse(Params, req.params).id));
  app.patch('/agents/:id', async (req, reply) => {
    const accountId = await owner(req), { id } = parse(Params, req.params), input = parse(Patch, req.body);
    if (input.status && !await flags.isOn('mission_kill')) return notFound(reply);
    return harness.update(accountId, id, input, limit());
  });
  app.delete('/agents/:id', async (req, reply) => {
    // TODO(spec): DELETE has no frozen result/deletion semantics. Disconnect and
    // revoke credentials while retaining policy history; return the updated Agent.
    return reply.send(await harness.update(await owner(req), parse(Params, req.params).id, { status: 'disconnected' }, limit()));
  });
  app.get('/agents/:id/policy', async req => harness.policy(await owner(req), parse(Params, req.params).id));
  // T reads/presets stay available; mutable Limits is only registered at D0.
  if (await flags.isOn('policy_editor')) app.put('/agents/:id/policy', async (req, reply) => {
    if (!await flags.isOn('policy_editor')) return notFound(reply);
    return harness.savePolicy(await owner(req), parse(Params, req.params).id, parse(SavePolicy, req.body));
  });
  app.get('/agents/:id/keys', async req => ({ keys: await harness.keys(await owner(req), parse(Params, req.params).id) }));
  app.post('/agents/:id/keys', async (req, reply) => {
    const accountId = await owner(req), { id } = parse(Params, req.params);
    parse(z.object({}).strict(), req.body ?? {});
    return reply.code(201).send(await harness.createKey(accountId, id));
  });
  app.delete('/agents/:id/keys/:keyId', async req => {
    const accountId = await owner(req), { id, keyId } = parse(KeyParams, req.params);
    await harness.revokeKey(accountId, id, keyId);
    return { ok: true };
  });
}
