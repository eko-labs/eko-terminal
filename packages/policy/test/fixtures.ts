import type { Agent, Approval, CoinCard, Policy, PreflightRequest, Verdict } from '@eko/shared';
import { CoinCardSchema } from '@eko/shared';
import fixture from '../../shared/test/fixtures/contracts/v1.json';
import type { Deps } from '../src/index.js';

export const NOW = Date.parse('2026-10-01T12:00:00Z');
export const ASSET = '0xabababababababababababababababababababab';
export const agent: Agent = { id: 'agent-1', name: 'Fixture', kind: 'onchain', status: 'active', uncheckedOrders24h: 0 };
export const request: PreflightRequest = { agentId: agent.id, clientOrderRef: 'order-001',
  order: { venue: 'rhc', instrument: ASSET, side: 'buy', orderType: 'market', notionalUsd: 100 },
  context: { reportedAt: new Date(NOW).toISOString(), cashUsd: 10_000 } };
export const policy: Policy = { mode: 'balanced', blockPlaybookLevel: 'danger', killed: false, version: 1 };
export const verdict: Verdict = { coin: ASSET, level: 'clear', reasons: ['fixture risk'], playbooks: [],
  receipt: { id: 'receipt-1', hash: 'fixture', status: 'pending' }, schemaVersion: '1', asOfBlock: 1 };
export const card: CoinCard = CoinCardSchema.parse(fixture.CoinCard);
card.verdict = verdict;
card.liquidity.depthUsd.pct2 = 100_000;
card.tradeability.exitCostPct = { usd100: 1, usd1k: 3, usd10k: 15 };
export const approval: Approval = { id: 'approval-1', agentId: agent.id, preflightId: 'preflight-1',
  summary: 'Fixture order', status: 'pending', expiresAt: new Date(NOW + 900_000).toISOString() };
export const deps: Deps = { now: () => NOW, verdictFor: () => verdict, cardFor: () => card,
  priceFor: () => undefined, approvalFor: () => undefined, approvalsAvailable: true };
