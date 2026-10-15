import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { concat, encodeAbiParameters, encodeEventTopics, keccak256, stringToHex } from 'viem';
import type { Abi, Hex } from 'viem';
import { canonicalize, createGuardReceiptCodec, GuardAssessmentV2Schema, GuardReceiptPayloadSchema,
  ReceiptLookupSchema, type ReceiptItem, type PublicReceiptPayload } from '@eko/shared';
import { GuardReceiptStore, GuardSourceStore, GuardVerdictStore, ReceiptOutbox, guardManifestId,
  binary, publishPrivateReceipt, publishReceipt, runRetention, type ReceiptCommitAnchor, type ReceiptRegistryReader } from '@eko/db';
import fixture from '../../../packages/shared/test/fixtures/receipts/guard-v2.json' with { type: 'json' };
import registryAbi from '../../../packages/chain/abi/eko/ReceiptsRegistry.json' with { type: 'json' };
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import v1 from '../../../packages/shared/test/fixtures/contracts/v1.json' with { type: 'json' };
import { SensesReadService } from '../src/read/senses.js';
import { accounts } from '../src/db/schema.js';

const codec = createGuardReceiptCodec({ concat, encodeAbiParameters, keccak256, stringToHex });
const registry = `0x${'ab'.repeat(20)}` as const, committer = `0x${'cd'.repeat(20)}` as const;
const at = '2026-10-02T00:00:00.000Z', commitSec = BigInt(Date.parse(at) / 1000 + 300);
let built: Awaited<ReturnType<typeof buildApp>>;
let now = Number(commitSec) * 1000;
const transactions = new Map<Hex, Awaited<ReturnType<ReceiptRegistryReader['getTransactionReceipt']>>>();
const get = (id: string, cookie = '') => built.app.inject({ url: `/v1/receipts/${encodeURIComponent(id)}`, headers: { cookie } });
function transaction(root: Hex, count: number, batchId: number) {
  const txHash = codec.hash(`fixture-tx-${batchId}`), blockHash = codec.hash(`fixture-block-${batchId}`);
  const topics = encodeEventTopics({ abi: registryAbi as Abi, eventName: 'BatchCommitted', args: { batchId: BigInt(batchId), root, committer } }) as Hex[];
  const tx: Awaited<ReturnType<ReceiptRegistryReader['getTransactionReceipt']>> = {
    status: 'success', transactionHash: txHash, blockNumber: BigInt(batchId + 100), blockHash,
    logs: [{ address: registry, topics, data: encodeAbiParameters([{ type: 'uint32' }], [count]), logIndex: 2 }],
  };
  transactions.set(txHash, tx);
  return tx;
}
async function anchor(items: ReceiptItem[], batchId: number) {
  const db = built.ctx.dbh.chain, tree = codec.buildReceiptTree(items), tx = transaction(tree.root, items.length, batchId);
  const id = `fixture-batch-${batchId}`;
  await db.sql.query('INSERT INTO receipt_batches VALUES($1,4663,$2,$3,$4,$4)', [id, tree.root, items.length, at]);
  for (const [index, item] of items.entries()) await db.sql.query('INSERT INTO receipt_batch_items VALUES($1,$2,$3,$4)', [id, item.id, index, JSON.stringify(tree.proofs[index])]);
  await db.sql.query('INSERT INTO receipt_commit_attempts(tx_hash,batch_id,registry,committer,nonce,raw_transaction) VALUES($1,$2,$3,$4,0,$5)', [tx.transactionHash, id, registry, committer, '0x']);
  const data: ReceiptCommitAnchor = { root: tree.root, batchId, leafCount: items.length, registry, committer,
    txHash: tx.transactionHash, blockNumber: String(tx.blockNumber), blockHash: tx.blockHash, logIndex: 2 };
  await db.sql.query('INSERT INTO receipt_commit_anchors(id,batch_id,tx_hash,data) VALUES($1,$2,$3,$4)', [id, id, tx.transactionHash, JSON.stringify(data)]);
  return { tree, tx, data, id };
}
async function storedFixture(sample: (typeof fixture.items)[number]): Promise<ReceiptItem> {
  const item = { id: sample.id, kind: sample.kind, hash: sample.hash } as ReceiptItem;
  await built.ctx.dbh.chain.sql.query(`INSERT INTO receipt_items(id,producer,kind,chain_id,revision_id,payload_hash,leaf,canonical_payload,data,recorded_at)
    VALUES($1,'fixture', $2,4663,$8,$3,$4,$5,$6,$7)`, [item.id, item.kind, item.hash, codec.encodeReceiptLeaf(item), sample.canonicalPayload, JSON.stringify(sample.payload), at,
      'revisionId' in sample.payload ? sample.payload.revisionId : item.id]);
  return item;
}
function payload(id: string): PublicReceiptPayload {
  const input = { raw: '900719925474099312345', status: 'observed' };
  return { schemaVersion: 'public-receipt-1', canonicalization: 'jcs-rfc8785/v1', receiptId: id, revisionId: id,
    chainId: 4663, coin: registry, kind: 'forecast', recordedAt: at, modelIds: ['fixture-model'], personaSetVersion: 'fixture-personas',
    cardSchemaVersion: 'fixture-card', rulesVersion: 'fixture-rules', outputSchemaVersion: 'forecast-1',
    snapshotHash: codec.hash(input), deterministicInput: input, decision: { probability: 0.25 },
    window: { kind: 'forecast', startsAt: 'commit_block', durationSec: 3600 }, supersedes: null, reorgOf: null };
}
beforeAll(async () => {
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', LEGACY_API: 'false',
    SESSION_SECRET: 'fixture-receipt-placeholder'.repeat(2), RECEIPTS_REGISTRY_ADDRESS: registry }), { startBackground: false });
  built.ctx.receipts.now = () => now;
  vi.spyOn(built.ctx.receipts.reader, 'getChainId').mockResolvedValue(4663);
  vi.spyOn(built.ctx.receipts.reader, 'getTransactionReceipt').mockImplementation(async ({ hash }) => {
    const tx = transactions.get(hash); if (!tx) throw new Error('Unknown fixture transaction'); return tx;
  });
  vi.spyOn(built.ctx.receipts.reader, 'getBlock').mockImplementation(async ({ blockNumber }) => {
    const tx = [...transactions.values()].find(t => t.blockNumber === blockNumber);
    return { hash: tx?.blockHash ?? null, timestamp: commitSec } as Awaited<ReturnType<typeof built.ctx.receipts.reader.getBlock>>;
  });
});
afterAll(async () => { vi.restoreAllMocks(); await built?.close(); });

describe('081 receipt API: synthetic PGlite/logs and HTTP injection, no live evidence', () => {
  it('returns pending without root/proof/tx/payload, including prepared but uncommitted items', async () => {
    const raw = payload('pending-forecast'); await publishReceipt(built.ctx.dbh.chain, 'fixture', raw);
    expect((await get(raw.receiptId)).json().status).toBe('pending'); // durable, not yet consumed
    const outbox = new ReceiptOutbox(built.ctx.dbh.chain), item = await outbox.enqueue(raw.receiptId);
    const tree = codec.buildReceiptTree([item]);
    await built.ctx.dbh.chain.sql.query('INSERT INTO receipt_batches VALUES($1,4663,$2,1,$3,$3)', ['prepared-only', tree.root, at]);
    await built.ctx.dbh.chain.sql.query('INSERT INTO receipt_batch_items VALUES($1,$2,0,$3)', ['prepared-only', item.id, '[]']);
    const before = JSON.stringify(built.ctx.chains.meter.usage());
    const response = await get(item.id);
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ id: item.id, kind: item.kind, hash: item.hash, leaf: tree.leaves[0], canonicalization: 'jcs-rfc8785/v1', status: 'pending' });
    expect(ReceiptLookupSchema.safeParse(response.json()).success).toBe(true);
    expect(JSON.stringify(built.ctx.chains.meter.usage())).toBe(before);
    expect((await get('unknown')).statusCode).toBe(404);
    expect((await get('x'.repeat(257))).statusCode).toBe(422);
  });
  it('serves exact historical V1 and current V2 fixture bytes/proofs without presentation changes', async () => {
    const samples = fixture.items.filter(i => i.case === 'v1-verdict' || i.case === 'exact-threshold');
    const items = await Promise.all(samples.map(storedFixture));
    const anchored = await anchor(items, 37);
    for (const [index, item] of items.entries()) {
      const response = await get(item.id);
      expect(response.statusCode, response.body).toBe(200);
      const result = ReceiptLookupSchema.parse(response.json()); expect(result.status).toBe('anchored');
      if (result.status !== 'anchored') throw new Error('Expected anchor');
      expect(result).toMatchObject({ batchId: 37, merkleRoot: anchored.tree.root, txHash: anchored.tx.transactionHash,
        block: 137, registry, chainId: 4663, logIndex: 2, leaf: samples[index]!.leaf, proof: anchored.tree.proofs[index],
        canonicalPayload: samples[index]!.canonicalPayload, revealed: samples[index]!.payload });
      expect(codec.verifyPublicProof(result.revealed, item, result.proof, result.merkleRoot)).toBe(true);
    }
  });
  it('withholds legacy and versioned forecasts until the exact commit-block window boundary', async () => {
    const old = await storedFixture(fixture.items.find(i => i.case === 'v1-forecast')!);
    const raw = payload('versioned-forecast'); await publishReceipt(built.ctx.dbh.chain, 'fixture', raw);
    const current = await new ReceiptOutbox(built.ctx.dbh.chain).enqueue(raw.receiptId);
    await anchor([old, current], 38);
    for (const item of [old, current]) {
      now = (Number(commitSec) + 3600) * 1000 - 1;
      const hidden = (await get(item.id)).json(); expect(hidden.status).toBe('anchored');
      expect(hidden).not.toHaveProperty('revealed'); expect(hidden).not.toHaveProperty('canonicalPayload');
      now++; const revealed = (await get(item.id)).json();
      expect(codec.hash(revealed.revealed)).toBe(item.hash); expect(revealed.canonicalPayload).toBe(canonicalize(revealed.revealed));
    }
  });
  it('rejects tampered stored payload, leaf, proof, root and anchor-item binding', async () => {
    const id = fixture.items.find(i => i.case === 'exact-threshold')!.id, db = built.ctx.dbh.chain;
    const originalQuery = db.sql.query.bind(db.sql);
    for (const edit of [
      (rows: Record<string, unknown>[]) => { rows[0]!.data = {}; },
      (rows: Record<string, unknown>[]) => { rows[0]!.leaf = codec.hash('wrong-leaf'); },
    ]) {
      const rows = structuredClone((await originalQuery('SELECT * FROM receipt_items WHERE id=$1', [id])).rows); edit(rows);
      const spy = vi.spyOn(db.sql, 'query').mockResolvedValueOnce({ rows });
      try { const res = await get(id); expect(res.statusCode).toBe(500); expect(res.json()).toEqual({ error: 'internal_error', message: 'Receipt verification data is unavailable' }); }
      finally { spy.mockRestore(); }
    }
    const itemRows = (await originalQuery('SELECT * FROM receipt_items WHERE id=$1', [id])).rows;
    const anchorRows = (await originalQuery(`SELECT a.data,i.proof,b.root,b.leaf_count,a.tx_hash,t.registry,t.committer FROM receipt_batch_items i
      JOIN receipt_batches b ON b.id=i.batch_id JOIN receipt_commit_anchors a ON a.batch_id=b.id JOIN receipt_commit_attempts t ON t.tx_hash=a.tx_hash WHERE i.receipt_id=$1`, [id])).rows;
    for (const field of ['proof', 'root', 'batchId', 'payloadHash', 'txHash', 'committer', 'registry']) {
      const rows = structuredClone(anchorRows), row = rows[0]!, data = row.data as Record<string, unknown>;
      if (field === 'proof') row.proof = [codec.hash('wrong-proof')];
      else if (field === 'root') row.root = codec.hash('wrong-root');
      else if (field === 'batchId') data.batchId = 999;
      else if (field === 'payloadHash') { data.receiptId = id; data.payloadHash = codec.hash('wrong-payload'); }
      else if (field === 'txHash') data.txHash = codec.hash('wrong-tx');
      else data[field] = `0x${'ef'.repeat(20)}`;
      const spy = vi.spyOn(db.sql, 'query').mockResolvedValueOnce({ rows: itemRows }).mockResolvedValueOnce({ rows });
      try { expect((await get(id)).statusCode, field).toBe(500); } finally { spy.mockRestore(); }
    }
  });
  it('requires the actual matching registry event, successful transaction and canonical chain/block', async () => {
    const id = fixture.items.find(i => i.case === 'v1-verdict')!.id, hash = codec.hash('fixture-tx-37'), original = structuredClone(transactions.get(hash)!);
    for (const edit of [
      (tx: typeof original) => { tx.status = 'reverted'; },
      (tx: typeof original) => { tx.transactionHash = codec.hash('foreign-transaction'); },
      (tx: typeof original) => { tx.blockNumber = 999n; },
      (tx: typeof original) => { tx.logs = []; },
      (tx: typeof original) => { tx.logs = [{ ...tx.logs[0]!, removed: true }]; },
      (tx: typeof original) => { tx.logs = [{ ...tx.logs[0]!, address: committer }]; },
      (tx: typeof original) => { tx.logs = [{ ...tx.logs[0]!, logIndex: 9 }]; },
      (tx: typeof original) => { tx.logs = [{ ...tx.logs[0]!, data: encodeAbiParameters([{ type: 'uint32' }], [999]) }]; },
      (tx: typeof original) => { tx.logs = [...tx.logs, ...tx.logs]; },
      (tx: typeof original) => { tx.logs = [{ ...tx.logs[0]!, topics: [tx.logs[0]!.topics[0]!, codec.hash('unknown-batch'), ...tx.logs[0]!.topics.slice(2)] }]; },
      (tx: typeof original) => { tx.logs = [{ ...tx.logs[0]!, topics: [tx.logs[0]!.topics[0]!, tx.logs[0]!.topics[1]!, codec.hash('wrong-event-root'), tx.logs[0]!.topics[3]!] }]; },
    ]) {
      const changed = structuredClone(original); edit(changed); transactions.set(hash, changed);
      try { expect((await get(id)).statusCode).toBe(500); } finally { transactions.set(hash, original); }
    }
    const chain = vi.spyOn(built.ctx.receipts.reader, 'getChainId').mockResolvedValueOnce(1);
    expect((await get(id)).statusCode).toBe(500); expect(chain).toHaveBeenCalled();
    vi.spyOn(built.ctx.receipts.reader, 'getBlock').mockResolvedValueOnce({ hash: codec.hash('orphan'), timestamp: commitSec });
    expect((await get(id)).statusCode).toBe(500);
  });
  it('reads pre-080 Guard anchors before and after outbox recovery and hides orphaned anchors', async () => {
    const db = built.ctx.dbh.chain, sample = GuardReceiptPayloadSchema.parse(fixture.items.find(i => i.case === 'exact-threshold')!.payload);
    const manifestInput = { sourceId: 'fixture-api-guard', sourceRevision: codec.hash('api-source'), replayMode: 'production' as const,
      cut: sample.decision.availabilityCut, watermark: sample.decision.cursor };
    const manifest = await new GuardSourceStore(db).putManifest({ ...manifestInput, id: guardManifestId(manifestInput), acquiredAt: at });
    const revision = await new GuardVerdictStore(db).putRevision({ assessment: GuardAssessmentV2Schema.parse({ ...sample.decision,
      receipt: { status: 'recorded', id: 'calculation-only', payloadHash: codec.hash(null) } }), deterministicInput: sample.deterministicInput,
      manifestId: manifest.id, sourceRevision: manifest.sourceRevision, context: sample.revisionKey.context, dependencyIds: [], recordedAt: at, runId: 'fixture-api-run' });
    const id = revision.data.assessment.receipt.id, store = new GuardReceiptStore(db), batch = (await store.prepareBatch('2026-10-02T00:05:00.000Z'))!;
    const tx = transaction(batch.root, batch.items.length, 39);
    await store.recordAnchor(batch, tx.transactionHash, registry, 4663, built.ctx.receipts.reader, at);
    const before = (await get(id)).json(); expect(before.status).toBe('anchored');
    await new ReceiptOutbox(db).enqueue(id); expect((await get(id)).json()).toEqual(before);
    await store.refreshAnchors({ ...built.ctx.receipts.reader, getBlock: async () => ({ hash: codec.hash('replacement') }) }, 4663, at);
    expect((await get(id)).json().status).toBe('pending');
    await db.sql.query("INSERT INTO receipt_commit_anchor_events(anchor_id,kind) VALUES('fixture-batch-37','orphaned')");
    expect((await get(fixture.items.find(i => i.case === 'v1-verdict')!.id)).json().status).toBe('pending');
  });
  it('keeps private commitments public without account/journal/salt metadata for anonymous, owner and foreign sessions; POST reveal stays unavailable', async () => {
    const sessions = [];
    for (let i = 0; i < 2; i++) {
      const [account] = await built.ctx.dbh.db.insert(accounts).values({ kind: 'wallet' }).returning();
      const token = await built.ctx.auth.createSession(account!.id);
      sessions.push(`eko_sid=${encodeURIComponent(built.app.signCookie(token))}`);
    }
    const db = built.ctx.dbh.chain, id = 'fixture-private-receipt', hash = codec.hash('fixture-salted-private-commitment');
    await publishPrivateReceipt(db, id, hash, at);
    expect((await get(id)).json()).toMatchObject({ status: 'pending', kind: 'harness_private', hash });
    const item = await new ReceiptOutbox(db).enqueue(id);
    await anchor([item], 40);
    let expected: unknown;
    for (const cookie of ['', ...sessions]) {
      const response = await get(id, cookie); expect(response.statusCode).toBe(200);
      const result = ReceiptLookupSchema.parse(response.json()); expect(result).not.toHaveProperty('revealed'); expect(result).not.toHaveProperty('canonicalPayload');
      expect(response.body).not.toMatch(/salt|payload|account|agent|journal|ciphertext/i);
      if (expected) expect(result).toEqual(expected); else expected = result;
      const reveal = await built.app.inject({ method: 'POST', url: `/v1/receipts/${id}/reveal`, headers: { cookie }, payload: { payload: { text: 'fixture-private-note' }, salt: 'fixture-salt' } });
      expect(reveal.statusCode).toBe(404); expect(reveal.body).not.toContain('fixture-private-note');
    }
    await db.sql.query('DELETE FROM harness_journal WHERE receipt_item_id=$1', [id]);
    expect((await get(id)).json()).toEqual(expected);
  });
});


describe('retained receipt proof without the old payload',()=>{
  it('serves an expired current receipt with its summary, keeps the card and consumes the scoreboard',async()=>{
    const db=built.ctx.dbh.chain;
    const old:PublicReceiptPayload={...payload('retention-api-old'),kind:'verdict',decision:{level:'clear'},window:{kind:'snapshot',blockNumber:20,blockHash:codec.hash('retention-api-block')}};
    const next:PublicReceiptPayload={...old,receiptId:'retention-api-next',revisionId:'retention-api-next',supersedes:old.receiptId};
    await publishReceipt(db,'engines',old);await publishReceipt(db,'engines',next);
    await publishReceipt(db,'engines',{...old,receiptId:'retention-api-pending',revisionId:'retention-api-pending'});
    const outbox=new ReceiptOutbox(db),items=[await outbox.enqueue(old.receiptId),await outbox.enqueue(next.receiptId)];
    const card={...structuredClone(v1.CoinCard),identity:{...v1.CoinCard.identity,address:registry},
      verdict:{...v1.CoinCard.verdict,coin:registry,receipt:{id:old.receiptId,hash:items[0]!.hash,status:'committed'}}};
    await db.sql.query("INSERT INTO coin_cards VALUES('sample-retention-card',$1,20,'fixture',$2,'1.0.0')",[binary(registry),card]);
    await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'sample-retention-card',20,$2)",[binary(registry),card]);
    const cardBefore=await built.ctx.reads.store.card(registry);
    await anchor(items,9001);const before=(await get(old.receiptId)).json();expect(before.status).toBe('anchored');expect(before.revealed).toEqual(old);
    await runRetention(db,{quoteTokens:[],ratingDays:7,receiptHours:48,dryRun:false,pauseMs:0,now:()=>Date.parse('2026-11-01T00:00:00Z')});
    const pending=await get('retention-api-pending');expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({status:'pending',payloadStatus:'expired',summary:{receiptId:'retention-api-pending',level:'clear'}});
    const after=(await get(old.receiptId)).json();expect(after.status).toBe('anchored');expect(after.revealed).toBeUndefined();expect(after.canonicalPayload).toBeUndefined();
    const {revealed:_r,canonicalPayload:_c,...proof}=before;
    expect(after).toEqual({...proof,payloadStatus:'expired',summary:expect.objectContaining({coin:registry,receiptId:old.receiptId,level:'clear'})});
    expect(await built.ctx.reads.store.card(registry)).toEqual(cardBefore);
    const senses=new SensesReadService({} as never,built.ctx.receipts);
    expect(await senses.receipt(old.receiptId)).toEqual(after);
    const scoreboard=await built.ctx.reads.scoreboard.list('calls');
    expect(scoreboard.rows).toEqual(expect.arrayContaining([expect.objectContaining({receiptId:old.receiptId,level:'clear',coin:registry})]));
    expect(codec.verifyReceiptProof(items[0]!,after.proof,after.merkleRoot)).toBe(true);
  });
});
