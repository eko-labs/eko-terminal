import v1 from './v1.json';
import { receiptSamples } from './public-receipts.js';
export const sensesSamples = {
  SenseUnavailable: { status: 'unavailable', reason: 'coin_unavailable' },
  SenseCoinCard: v1.CoinCard,
  SenseVerdictResult: v1.Verdict,
  SenseCardResult: { status: 'unavailable', reason: 'coin_unavailable' },
  SensePlaybookResult: { playbooks: [], history: 'unavailable' },
  SenseCensusResult: { gated: true, reason: 'Wallet-label precision has not passed the publication gate.',
    methodologyUrl: '/census#methodology', gate: { metric: 'likely_agent_precision', value: null, wilsonLower: null, recall: null,
      threshold: 0.9, modelVersion: 'fp-1.0.0', evaluatedAt: null, expiresAt: null, modelHash: null, datasetHash: null, evidence: null },
    chain: [], coins: [], asOf: '2026-10-13T12:00:00.000Z' },
  SenseReceiptResult: receiptSamples.ReceiptLookup,
};
