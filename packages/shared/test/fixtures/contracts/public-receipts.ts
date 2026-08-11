import type { PublicReceiptPayload, ReceiptLookup } from '../../../src/contracts/public-receipts.js';

// Structural contract fixture only; hashing/proof assertions live in db tests.
export const receiptSamples = {
  ReceiptSummary: {coin:`0x${'ab'.repeat(20)}`,receiptId:'fixture-public-receipt',revisionId:'fixture-revision',
    recordedAt:'2026-10-02T00:00:00.000Z',rulesVersion:'fixture-rules-1',level:'pending',supersedes:null,reorgOf:null,
    window:{kind:'snapshot',blockNumber:123,blockHash:null}},
  ReceiptLookup: { id: 'fixture-pending-receipt', kind: 'verdict', status: 'pending',
    hash: `0x${'ab'.repeat(32)}`, leaf: `0x${'cd'.repeat(32)}`, canonicalization: 'jcs-rfc8785/v1' } satisfies ReceiptLookup,
  PublicReceiptPayload: {
    schemaVersion:'public-receipt-1',canonicalization:'jcs-rfc8785/v1',receiptId:'fixture-public-receipt',revisionId:'fixture-revision',
    kind:'verdict',chainId:4663,coin:`0x${'ab'.repeat(20)}`,recordedAt:'2026-10-02T00:00:00.000Z',
    modelIds:[],personaSetVersion:null,cardSchemaVersion:'fixture-card-1',rulesVersion:'fixture-rules-1',outputSchemaVersion:'verdict-1',
    snapshotHash:`0x${'cd'.repeat(32)}`,deterministicInput:{status:'missing'},decision:{level:'pending'},
    window:{kind:'snapshot',blockNumber:123,blockHash:null},supersedes:null,reorgOf:null,
  } satisfies PublicReceiptPayload,
};
