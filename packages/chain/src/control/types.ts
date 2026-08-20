import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, GUARD_CAPABILITIES } from '@eko/shared';
import type { createMeteredClients } from '../rpc/clients.js';

export const CONTROL_METHOD_VERSION = '2.1.0' as const;
export const controlBytes = z.string().regex(/^0x(?:[0-9a-f]{2})*$/i).max(100_002).transform(v => v.toLowerCase() as `0x${string}`);
const address = AddressSchema.transform(v => v.toLowerCase() as `0x${string}`);
const hash = Bytes32Schema;
export const ControlReadSchema = z.strictObject({ target: address, data: controlBytes });
const transaction = z.strictObject({ target: address, data: controlBytes.refine(v => v.length >= 10), value: z.literal('0') });
/** A recipe needs captured review evidence binding its read to the capability. Selector discovery is only a lead. */
export const ControlRecipeSchema = z.strictObject({
  capability: z.enum(GUARD_CAPABILITIES), implementationHash: hash, configurationHash: hash,
  authority: address, authorityTarget: address, caller: address, selector: z.string().regex(/^0x[0-9a-f]{8}$/),
  execute: transaction, queue: transaction.nullable(), delaySec: z.number().int().min(0).max(86400),
  read: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('call'), target: address, data: controlBytes }),
    z.strictObject({ kind: z.literal('storage'), target: address, slot: hash }),
  ]),
  effect: z.enum(['uint_increase', 'uint_decrease', 'false_to_true', 'address_change']),
  reviewEvidenceIds: z.array(hash).min(1).max(16),
}).superRefine((v, ctx) => {
  if ((v.delaySec > 0) !== (v.queue !== null)) ctx.addIssue({ code: 'custom', message: 'Delayed capability requires a queue and early execution negative' });
});
export type ControlRecipe = z.infer<typeof ControlRecipeSchema>;
export type ControlRead = z.infer<typeof ControlReadSchema>;
const role = z.strictObject({ target: address, kind: z.enum(['owner', 'get_owner', 'proxy_admin', 'default_admin']), address,
  codeHash: hash.nullable(), inert: z.boolean() });
const path = z.strictObject({ address, codeHash: hash, kind: z.enum(['eip1967', 'beacon', 'clone', 'unknown']), next: address.nullable(), beacon: address.nullable(), beaconCodeHash: hash.nullable() });
const suspicion = z.strictObject({ address, selector: z.string().regex(/^0x[0-9a-f]{8}$/), capability: z.enum(GUARD_CAPABILITIES).nullable(), category: z.enum(['tax', 'blacklist', 'pause', 'mint', 'upgrade', 'limit']) });
export const ControlInspectionSchema = z.strictObject({
  methodVersion: z.literal(CONTROL_METHOD_VERSION), coin: address, cursor: GuardCursorSchema,
  path: z.array(path).max(4), roles: z.array(role).max(64), selectors: z.array(suspicion).max(128),
  configuration: z.array(z.strictObject({ target: address, data: controlBytes, result: controlBytes.nullable() })).max(16),
  implementationHash: hash.nullable(), configurationHash: hash, profileHash: hash,
  resolution: z.enum(['unknown', 'bounded_proxy']), gaps: z.array(z.enum(['missing', 'unsupported', 'failed'])), requests: z.number().int().nonnegative().max(128),
});
export type ControlInspection = z.infer<typeof ControlInspectionSchema>;
export const ControlConfirmationSchema = z.strictObject({
  recipe: ControlRecipeSchema, status: z.enum(['changed', 'no_change', 'reverted', 'unknown_authority', 'unsupported', 'failed']),
  before: controlBytes.nullable(), after: controlBytes.nullable(), earlyRejected: z.boolean().nullable(),
  elapsedSec: z.number().int().nonnegative().nullable(), traceHash: hash, trace: z.array(z.unknown()).max(32),
});
export type ControlConfirmation = z.infer<typeof ControlConfirmationSchema>;
export const ControlProfileSchema = z.strictObject({
  schemaVersion: z.literal('generic-control-profile-1'), inspection: ControlInspectionSchema,
  confirmations: z.array(ControlConfirmationSchema).max(16), id: hash,
});
export type ControlProfile = z.infer<typeof ControlProfileSchema>;
/** This boundary accepts the existing metered archive client, never a URL or raw paid transport. */
export type ControlClients = Pick<ReturnType<typeof createMeteredClients>, 'archive'>;
