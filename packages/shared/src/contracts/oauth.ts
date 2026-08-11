import { z } from 'zod';
import { AddressSchema, UntrustedSchema } from './common.js';
// BACKEND §9.1 (BE-3): grant scopes map to exactly one agent's key.
export const OAuthScopeSchema = z.enum(['senses:read', 'preflight', 'journal', 'loops', 'research', 'kill']);
export type OAuthScope = z.infer<typeof OAuthScopeSchema>;
// TODO(spec): fields — §23/BE-3 has no named grant/request types block. These minimal
// shapes follow §9.1's grant storage and consent endpoint; lifecycle fields remain unspecified.
export const OAuthGrantSchema = z.object({
  accountId: z.string(), agentId: z.string(), wallet: AddressSchema,
  scopes: z.array(OAuthScopeSchema),
});
export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;
export const OAuthRequestSchema = z.object({
  id: z.uuid(), clientName: UntrustedSchema, redirectUri: z.url(), redirectHost: z.string(), scopes: z.array(OAuthScopeSchema),
  resource: z.url(), expiresAt: z.iso.datetime(),
});
export type OAuthRequest = z.infer<typeof OAuthRequestSchema>;
export const OAuthConsentSchema = z.object({
  requestId: z.uuid(), agentId: z.uuid().optional(), newAgentName: z.string().trim().min(1).max(120).optional(),
  preset: z.enum(['safe', 'balanced', 'degen']).optional(),
  scopes: z.array(OAuthScopeSchema).max(6), decision: z.enum(['approve', 'deny']),
}).strict().refine(v => v.decision === 'deny' || (!!v.agentId !== !!v.newAgentName), 'Choose or create one agent');
export type OAuthConsent = z.infer<typeof OAuthConsentSchema>;
export const OAuthTokenGrantSchema = z.union([
  z.object({ grant_type: z.literal('authorization_code'), code: z.string(), code_verifier: z.string(), redirect_uri: z.string(), client_id: z.string() }),
  z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string() }),
]);
export type OAuthTokenGrant = z.infer<typeof OAuthTokenGrantSchema>;
export const OAuthTokenSchema = z.object({
  access_token: z.string(), refresh_token: z.string(), token_type: z.literal('Bearer'), expires_in: z.number(), scope: z.string(),
});
export type OAuthToken = z.infer<typeof OAuthTokenSchema>;

export const OAuthConsentResultSchema = z.object({ redirect: z.url() });
export type OAuthConsentResult = z.infer<typeof OAuthConsentResultSchema>;
