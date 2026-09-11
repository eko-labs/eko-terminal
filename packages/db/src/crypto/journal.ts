import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonicalize } from '@eko/shared';
import { keccak256 } from 'viem';

export const JOURNAL_MAX_BYTES = 16 * 1024;
export interface SealedEntry { iv: Buffer; ciphertext: Buffer; saltCt: Buffer; commitment: `0x${string}` }
const aad = (entryId: string, agentId: string) => {
  // Fixed-width UUIDs make the specified id || agent concatenation unambiguous.
  if (![entryId, agentId].every(id => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) throw new Error('Invalid journal identity');
  return Buffer.from(entryId + agentId);
};
function encrypt(key: Buffer, iv: Buffer, data: Buffer, associated: Buffer) {
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(associated);
  return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}
function decrypt(key: Buffer, iv: Buffer, data: Buffer, associated: Buffer) {
  if (iv.length !== 12 || data.length < 16) throw new Error('Journal authentication failed');
  // The tag is pinned to 16 bytes so Node itself rejects any shorter (truncated) tag.
  const cipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(associated); cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]);
}
/**
 * Require a nonarray object, canonicalize it and enforce the 16 KB plaintext bound. Pure caller-
 * supplied payload processing without account auth; invalid/noncanonicalizable/oversized input
 * throws.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
 */
export function journalBytes(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Journal payload must be an object');
  const bytes = Buffer.from(canonicalize(payload));
  if (bytes.length > JOURNAL_MAX_BYTES) throw new Error('Journal payload exceeds 16 KB');
  return bytes;
}
/**
 * Encrypt canonical payload and random salt with AES-256-GCM under fresh nonces and UUID
 * attribution; return ciphertext plus salted commitment. Caller authorizes account/agent and
 * supplies a valid 256-bit DEK; invalid identity/payload/key or crypto failures throw. Temporary
 * plaintext/salt buffers are zeroed in finally.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
 */
export function sealEntry(dek: Buffer, entryId: string, agentId: string, payload: unknown): SealedEntry {
  const bytes = journalBytes(payload), associated = aad(entryId, agentId), salt = randomBytes(32), iv = randomBytes(12), saltIv = randomBytes(12);
  try {
    return { iv, ciphertext: encrypt(dek, iv, bytes, associated),
      saltCt: Buffer.concat([saltIv, encrypt(dek, saltIv, salt, Buffer.concat([associated, Buffer.from(':salt')]))]),
      commitment: keccak256(Buffer.concat([salt, bytes])) };
  } finally { salt.fill(0); bytes.fill(0); }
}
/**
 * Authenticate payload/salt with UUID attribution, recompute salted commitment and require
 * canonical object bytes before returning payload and salt. Caller checks ownership/destruction
 * and supplies DEK. Tampering, wrong key/identity, invalid encoding or commitment mismatch throws
 * fixed authentication failure; caller must zero returned salt.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
 */
export function openEntry(dek: Buffer, entryId: string, agentId: string, sealed: SealedEntry): { payload: unknown; salt: Buffer } {
  let bytes: Buffer | undefined, salt: Buffer | undefined;
  try {
    const associated = aad(entryId, agentId);
    bytes = decrypt(dek, sealed.iv, sealed.ciphertext, associated);
    salt = decrypt(dek, sealed.saltCt.subarray(0, 12), sealed.saltCt.subarray(12), Buffer.concat([associated, Buffer.from(':salt')]));
    if (salt.length !== 32 || keccak256(Buffer.concat([salt, bytes])) !== sealed.commitment) throw new Error('Commitment mismatch');
    const payload: unknown = JSON.parse(bytes.toString());
    if (!journalBytes(payload).equals(bytes)) throw new Error('Noncanonical payload');
    return { payload, salt };
  } catch { salt?.fill(0); throw new Error('Journal authentication failed'); }
  finally { bytes?.fill(0); }
}
/**
 * Wrap exactly 32 DEK bytes with fresh AES-GCM nonce and canonical account/version/KEK-id
 * associated data. Caller authorizes key lifecycle and supplies KEK; wrong length, invalid
 * key/data or crypto errors throw.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
 */
export function wrapDek(kek: Buffer, accountId: string, version: number, kekId: string, dek: Buffer) {
  if (dek.length !== 32) throw new Error('Invalid data key');
  const iv = randomBytes(12);
  return Buffer.concat([iv, encrypt(kek, iv, dek, Buffer.from(canonicalize({ accountId, version, kekId })))]);
}
/**
 * Authenticate wrapped DEK against KEK/account/version/id and require 32 recovered bytes. Caller
 * must consult the current destruction ledger first. Wrong identity/key/tag/encoding throws fixed
 * key-authentication failure; caller owns returned key zeroing.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Journal encryption and destruction invariants}
 */
export function unwrapDek(kek: Buffer, accountId: string, version: number, kekId: string, wrapped: Buffer) {
  try {
    const dek = decrypt(kek, wrapped.subarray(0, 12), wrapped.subarray(12), Buffer.from(canonicalize({ accountId, version, kekId })));
    if (dek.length !== 32) { dek.fill(0); throw new Error('Invalid data key'); }
    return dek;
  } catch { throw new Error('Journal key authentication failed'); }
}
