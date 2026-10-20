import type { ApiError, ErrorCode, FlagName } from '@eko/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { FlagService } from '../../flags/service.js';

// BACKEND §15.1: unspecified refusals use 422, including bad_request.
// TODO(spec): internal_error has no explicit status; use 500 for server failures, not a refusal.
export const ERROR_STATUS = {
  bad_request: 422, unauthorized: 401, wallet_auth_required: 401, tier_required: 422,
  quota_exceeded: 429, rate_limited: 429, not_found: 404, guard_refused: 422,
  stale_data: 422, trade_cap_exceeded: 422, trading_paused: 422, sanctioned: 422,
  quote_changed: 422, quote_expired: 422, anti_snipe_active: 422, no_route: 422,
  sim_unavailable: 503, approval_required: 422, wallet_mismatch: 422,
  payment_required: 402, internal_error: 500, conflict: 409, forbidden: 403, not_allowlisted: 403,
} satisfies Record<ErrorCode, number>;

export function sendError(reply: FastifyReply, code: ErrorCode, message: string, extra: Omit<ApiError, 'error' | 'message'> = {}) {
  const body: ApiError = { ...extra, error: code, message };
  return reply.status(ERROR_STATUS[code]).send(body);
}

export const notFound = (reply: FastifyReply) => sendError(reply, 'not_found', 'Not found');

export function list<T>(rows: T[], cursor: string | null = null, delayedSec?: number) {
  return { rows, cursor, ...(delayedSec === undefined ? {} : { delayedSec }) };
}

export class InputError extends Error {
  readonly code = 'bad_request';
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new InputError(`${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'Invalid input'}`);
  }
  return result.data;
}

export function parseInput<P, Q, B>(req: FastifyRequest, schemas: { params: z.ZodType<P>; query: z.ZodType<Q>; body: z.ZodType<B> }) {
  return { params: parse(schemas.params, req.params), query: parse(schemas.query, req.query), body: parse(schemas.body, req.body) };
}

type Handler = (req: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>;

export function routeHelpers(flags: FlagService) {
  return {
    flagged(flag: FlagName, handler: Handler): Handler {
      // TODO(spec): Runtime hiding implements "not registered" without restarting the router.
      return async (req, reply) => {
        if (!req.demoSession?.flags.includes(flag) && !await flags.isOn(flag)) return notFound(reply);
        return handler(req, reply);
      };
    },
  };
}
