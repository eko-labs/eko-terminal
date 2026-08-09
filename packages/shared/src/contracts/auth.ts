import { z } from 'zod';

// BACKEND §23 CA-11; FRONTEND §4.2.
export const SIWE_STATEMENT = 'Sign in to EKO. This proves you own this wallet. It does not authorize any transaction or spending.';
export const SiweNonceSchema = z.object({
  nonce: z.string().regex(/^[a-zA-Z0-9]{8,}$/),
  domain: z.string().min(1),
  uri: z.url(),
  issuedAt: z.iso.datetime(),
  expirationTime: z.iso.datetime(),
});
export type SiweNonce = z.infer<typeof SiweNonceSchema>;
export const SiweVerifySchema = z.object({
  message: z.string().min(1).max(4000),
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(32768),
  ref: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
}).strict();
