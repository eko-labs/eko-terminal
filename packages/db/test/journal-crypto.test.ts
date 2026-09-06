import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { canonicalize } from '@eko/shared';
import { FileJournalDestructionLedger, journalBytes, openEntry, sealEntry, unwrapDek, wrapDek } from '../src/index.js';

describe('private journal envelope crypto (synthetic keys only)', () => {
  it('uses JCS, authenticated UUID attribution and salted commitments with fresh nonces/salts', () => {
    const dek = randomBytes(32), id = randomUUID(), agent = randomUUID(), payload = { z: 'sample-note', a: 7 };
    const first = sealEntry(dek,id,agent,payload), second = sealEntry(dek,id,agent,{ a:7,z:'sample-note' });
    const opened = openEntry(dek,id,agent,first), other = openEntry(dek,id,agent,second);
    expect(opened.payload).toEqual(payload);
    expect(first.commitment).toBe(keccak256(Buffer.concat([opened.salt,Buffer.from(canonicalize(payload))])));
    expect(opened.salt).toHaveLength(32); expect(opened.salt).not.toEqual(other.salt);
    expect(first.iv).not.toEqual(second.iv); expect(first.saltCt).not.toEqual(second.saltCt); expect(first.commitment).not.toEqual(second.commitment);
    expect(first.ciphertext.toString()).not.toContain('sample-note');
    for (const [entryId, agentId] of [[randomUUID(),agent],[id,randomUUID()]]) expect(() => openEntry(dek,entryId!,agentId!,first)).toThrow('authentication');
    expect(() => openEntry(randomBytes(32),id,agent,first)).toThrow('authentication');
    for (const field of ['iv','ciphertext','saltCt'] as const) {
      const altered = Buffer.from(first[field]); altered[0] = altered[0]! ^ 1;
      expect(() => openEntry(dek,id,agent,{...first,[field]:altered})).toThrow('authentication');
    }
    expect(() => openEntry(dek,id,agent,{...first,commitment:keccak256(Buffer.from('wrong'))})).toThrow('authentication');
    expect(() => openEntry(dek,id,agent,{...first,saltCt:second.saltCt})).toThrow('authentication');
    // The GCM tag is pinned to 16 bytes: a shortened ciphertext or salt envelope (truncated tag) never opens.
    for (const cut of [1,4,12]) {
      expect(() => openEntry(dek,id,agent,{...first,ciphertext:first.ciphertext.subarray(0,-cut)})).toThrow('authentication');
      expect(() => openEntry(dek,id,agent,{...first,saltCt:first.saltCt.subarray(0,-cut)})).toThrow('authentication');
    }
    opened.salt.fill(0); other.salt.fill(0); dek.fill(0);
  });
  it('authenticates the KEK, account, version and KEK id of a wrapped random 256-bit DEK', () => {
    const kek=randomBytes(32),dek=randomBytes(32),account=randomUUID(),wrapped=wrapDek(kek,account,1,'fixture-kek',dek);
    expect(wrapped).toHaveLength(60); expect(unwrapDek(kek,account,1,'fixture-kek',wrapped)).toEqual(dek);
    expect(wrapDek(kek,account,1,'fixture-kek',dek)).not.toEqual(wrapped);
    for (const [key,id,version,kekId] of [[randomBytes(32),account,1,'fixture-kek'],[kek,randomUUID(),1,'fixture-kek'],[kek,account,2,'fixture-kek'],[kek,account,1,'other-kek']] as const)
      expect(() => unwrapDek(key,id,version,kekId,wrapped)).toThrow('authentication');
    expect(() => unwrapDek(kek,account,1,'fixture-kek',wrapped.subarray(1))).toThrow('authentication');
  });
  it('limits canonical UTF-8 bytes, accepts exactly 16 KB, and rejects non-JSON payloads', () => {
    expect(journalBytes({text:'a'.repeat(16373)})).toHaveLength(16384);
    expect(() => journalBytes({text:'a'.repeat(16374)})).toThrow('16 KB');
    expect(() => journalBytes({text:'é'.repeat(8192)})).toThrow('16 KB');
    for (const value of [[],null,{x:Infinity},{x:undefined},{x:BigInt(1)},{x:'\ud800'}]) expect(() => journalBytes(value)).toThrow();
  });
  it('reopens durable tombstones and refuses missing/corrupt/truncated replacement ledgers', () => {
    const dir=mkdtempSync(join(tmpdir(),'eko-journal-ledger-')),path=join(dir,'destruction.log'),account=randomUUID(),at='2026-10-02T00:00:00.000Z';
    try {
      const ledger=new FileJournalDestructionLedger(path);
      expect(() => ledger.destroyedAt(account)).toThrow();
      writeFileSync(path,'eko-journal-destruction-v1\n',{mode:0o600});
      expect(ledger.destroyedAt(account)).toBeNull(); expect(ledger.destroy(account,at)).toBe(at);
      expect(new FileJournalDestructionLedger(path).destroy(account,'2026-10-03T00:00:00.000Z')).toBe(at);
      expect(readFileSync(path,'utf8').split('\n')).toHaveLength(3);
      writeFileSync(path,readFileSync(path,'utf8').slice(0,-1)); expect(() => ledger.destroyedAt(account)).toThrow();
      writeFileSync(path,'eko-journal-destruction-v1\ninvalid\n'); expect(() => ledger.destroyedAt(account)).toThrow();
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});
