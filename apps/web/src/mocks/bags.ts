import { BagReportSchema, PlaybookIdSchema, type BagReport } from '@eko/shared';
// Synthetic indexed holdings for offline tests only.
export const wallet = '0x1111111111111111111111111111111111111111' as const;
const coin = '0x2222222222222222222222222222222222222222' as const;
const text = (text: string) => ({ text, truncated: false, flags: [] });
export const bagFixture: BagReport = BagReportSchema.parse({ wallet, asOfBlock: 42, coverage: 'indexed_candidates', cursor: null,
  holdings: [{ coin: { address: coin, name: text('<img onerror=alert(1)>'), symbol: text('DEMO'), launchpad: 'other', stage: 'graduated', priceUsd: 3.25, liquidityUsd: 501, marketCapUsd: 901, change1hPct: 0, verdict: 'danger', ageSec: 0, evaluatedPlaybooks: PlaybookIdSchema.options },
    balance: '1234.5678', balanceStatus: 'observed', status: 'ready', valueUsd: 4012.345, playbooks: ['honeypot'], exitCost1kPct: 19 }], summary: { coins: 1, flagged: 1, danger: 1, valueUsd: 4012.345 } });
