import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import * as contracts from '../src/contracts/index.js';
import * as flags from '../src/flags.js';
import samples from './fixtures/contracts/v1.json';
import { guardSamples } from './fixtures/contracts/guard-v2.js';
import { sensesSamples } from './fixtures/contracts/mcp-senses.js';
import { reviewSamples } from './fixtures/contracts/guard-review.js';
import { actualOrderSamples } from './fixtures/contracts/actual-order.js';
import { ghostSamples } from './fixtures/contracts/ghost-reports.js';
import { receiptSamples } from './fixtures/contracts/public-receipts.js';
import { scoreboardSamples } from './fixtures/contracts/scoreboard.js';
import { swarmSamples } from './fixtures/contracts/swarm.js';
import { deployerHistorySamples } from './fixtures/contracts/deployer-history.js';
import type { WsEvent, WsEventMap, Address } from '../src/index.js';

const attributionGap={reason:'unattributed_swaps',window:'trailing_1h',status:'incomplete',threshold:0.05,totalCount:20,unattributedCount:2,
  totalVolumeUsd:100,unattributedVolumeUsd:10,countShare:0.1,volumeShare:0.1,unknownVolumeCount:0};
const sampleByName: Record<string, unknown> = { ...samples, ...sensesSamples, ...guardSamples, ...receiptSamples, ...ghostSamples, ...actualOrderSamples, ...swarmSamples, ...reviewSamples, ...scoreboardSamples, ...deployerHistorySamples, AttributionCoverageGap:attributionGap,
  ShareMeta: { title: 'EKO · Buyer risk snapshot', description: 'Pending', url: 'https://app.eko.example/receipt/sample-receipt', image: 'https://app.eko.example/og/scan/sample.png' },
};
const schemas = Object.entries({ ...contracts, ...flags }).filter(([name]) => name.endsWith('Schema')) as [string, z.ZodType][];

describe('frozen contract samples (FACTS §7, BACKEND §23)', () => {
  for (const [name, schema] of schemas) {
    it(`${name}: parses its specified valid sample and rejects malformed input`, () => {
      const sample = sampleByName[name.replace(/Schema$/, '')];
      expect(sample, `Missing fixture for ${name}`).toBeDefined();
      const parsed = schema.safeParse(sample);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      // This also detects stripped additive/optional fields, rather than merely parse success.
      expect(parsed.data).toEqual(sample);
      expect(schema.safeParse(null).success).toBe(false);
      if (typeof sample === 'object' && sample !== null && !Array.isArray(sample)) {
        // Every required typed field must reject omission and a wrong type.
        for (const key of Object.keys(sample)) {
          if (name === 'JournalEntrySchema' && key === 'payload') continue; // unknown accepts every value.
          const without = { ...sample } as Record<string, unknown>;
          delete without[key];
          if (!schema.safeParse(without).success) {
            expect(schema.safeParse({ ...sample, [key]: Symbol('invalid') }).success, `${name}.${key}`).toBe(false);
          }
        }
      }
    });
  }

  it('preserves named actor coverage on both coin sections and wallet-flow responses',()=>{
    const meta={confidence:0,asOfBlock:1,missing:['wallet_flow:unattributed'],coverageGaps:{wallet_flow:attributionGap}};
    expect(contracts.CoinCardMetaSchema.parse({flow:meta})).toEqual({flow:meta});
    expect(contracts.FlowSchema.parse({...samples.Flow,meta}).meta).toEqual(meta);
  });

  it('validates and normalizes addresses, including nested addresses', () => {
    const mixed = `0x${'AB'.repeat(20)}`;
    expect(contracts.AddressSchema.parse(mixed)).toBe(mixed.toLowerCase());
    expect(contracts.VerdictSchema.parse({ ...samples.Verdict, coin: mixed }).coin).toBe(mixed.toLowerCase());
    for (const bad of ['0x123', '0x' + 'gg'.repeat(20), 'ab'.repeat(20), '0x' + 'ab'.repeat(21)]) {
      expect(contracts.AddressSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('keeps the FACTS unions, optional fields, and unknown journal payload', () => {
    expect(contracts.LevelSchema.options).toEqual(['clear', 'monitor', 'danger', 'info']);
    expect(contracts.WalletLabelSchema.options).toEqual(['declared_agent', 'likely_agent', 'crew', 'human']);
    expect(contracts.PlaybookIdSchema.options).toEqual([
      'honeypot', 'tax_trap', 'removable_liquidity', 'fee_trap_pool', 'stuck_at_bonding',
      'wash_to_trend', 'clone_swarm', 'exempt_insiders', 'bundle_dump', 'migration_dump',
      'malicious_hook', 'agent_bait', 'serial_deployer', 'holder_concentration', 'dev_dump', 'run_up', 'launch_snipers',
    ]);
    expect(contracts.VerdictSchema.safeParse({ ...samples.Verdict, level: 'info' }).success).toBe(false);
    expect(contracts.EntitlementsSchema.safeParse({ ...samples.Entitlements, feeBps: 10 }).success).toBe(false);
    for (const feeBps of [0, 50, 40, 30, 25]) expect(contracts.EntitlementsSchema.safeParse({ ...samples.Entitlements, feeBps }).success).toBe(true);
    for (const payload of [null, false, 'text', [1], { text: 'opaque' }]) {
      expect(contracts.JournalEntrySchema.parse({ ...samples.JournalEntry, payload }).payload).toEqual(payload);
    }
    expect(contracts.JournalEntrySchema.safeParse({ ...samples.JournalEntry, payload: undefined }).success).toBe(true);
    const { payload: _, ...missingPayload } = samples.JournalEntry;
    expect(contracts.JournalEntrySchema.safeParse(missingPayload).success).toBe(false);
    const coreAgent = { id: 'a', name: 'fixture', kind: 'other', status: 'active', uncheckedOrders24h: 0 };
    expect(contracts.AgentSchema.parse(coreAgent)).toEqual(coreAgent);
    expect(contracts.AgentDetailSchema.safeParse(coreAgent).success).toBe(false);
  });

  it('preserves manual burn additions and old field names', () => {
    const manual = { ...samples.BurnStatsWithExtras, mode: 'manual' };
    delete (manual as Partial<typeof manual>).engine;
    expect(contracts.BurnStatsWithExtrasSchema.parse(manual)).toEqual(manual);
    expect(contracts.BurnStatsSchema.parse(manual)).toEqual(manual);
    expect(contracts.BurnStatsWithExtrasSchema.safeParse(samples.BurnStats).success).toBe(false);
    expect(contracts.BurnStatsSchema.parse(samples.BurnStats)).toEqual(samples.BurnStats);
    expect(contracts.TradeQuoteSchema.parse({ ...samples.TradeQuote, fee: { bps: 0, usd: 0, destination: null } }).fee.destination).toBeNull();
    expect(contracts.TradeQuoteSchema.safeParse({ ...samples.TradeQuote, fee: { bps: 50, usd: 1, destination: 'dev_wallet' } }).success).toBe(false);
  });

  it('retains optional receipt proofs without requiring them on core receipts', () => {
    const receipt = { ...samples.Receipt, ...samples.ReceiptProof };
    expect(contracts.ReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it('uses the prescribed LoopSpec and ResearchNote constraints', () => {
    expect(contracts.LoopSpecSchema.safeParse({ ...samples.LoopSpec, extra: true }).success).toBe(false);
    expect(contracts.LoopSpecSchema.safeParse({ ...samples.LoopSpec, timeframe: '1s' }).success).toBe(false);
    expect(contracts.LoopSpecSchema.safeParse({ ...samples.LoopSpec, entry: { all: [] } }).success).toBe(false);
    expect(contracts.OperandSchema.safeParse({ ind: 'ema', period: 401 }).success).toBe(false);
    expect(contracts.ResearchNoteSchema.safeParse({ ...samples.ResearchNote, summary: 'model prose' }).success).toBe(false);
    expect(contracts.ResearchNoteSchema.safeParse({ ...samples.ResearchNote, confidence: 1.1 }).success).toBe(false);
    expect(contracts.ResearchNoteSchema.safeParse({ ...samples.ResearchNote, sections: [{ title: 'playbooks', findings: Array(9).fill(samples.Untrusted), evidence: [] }] }).success).toBe(false);
  });
});

describe('flags, bus and versions', () => {
  const stages = {
    D0: ['approvals', 'mission_kill', 'policy_editor', 'unchecked_orders', 'loop_lab', 'deep_research', 'perps_panel', 'summon_x', 'beat_the_swarm', 'clear_badge', 'burn_board', 'onchain_guardrails', 'packs_chatgpt_openclaw'],
    'D0+1': ['tiers_active', 'trial', 'referrals'],
    'Drop 1': ['afi', 'x402_api', 'agent_annotations', 'lenses', 'agent_flow_tools'],
    'Drop 2': ['rug_ring_radar', 'leaderboards'], 'Drop 3': ['arena'], 'Drop 4': ['desk_live', 'ask_the_swarm'],
    'Drop 5': ['agent_launcher'], 'Drop 6': ['loop_lab_pro', 'stocks_lane'], 'Drop 7': ['eko_score', 'eko_inside'],
    'Drop 8': ['chain_base'], 'Drop 9': ['institutional_pack', 'marketplace', 'eko_agent'],
  };
  it('has exactly the §21.4 flags, excludes ops, and requires a complete record', () => {
    expect(flags.FLAG_STAGES).toEqual(stages);
    expect(flags.FlagNameSchema.options).toEqual(Object.values(stages).flat());
    expect(new Set(flags.FLAG_NAMES).size).toBe(flags.FLAG_NAMES.length);
    for (const key of ['trading_live', 'swarm_ranking', 'unknown']) {
      expect(flags.FlagNameSchema.safeParse(key).success).toBe(false);
      expect(flags.FlagsSchema.safeParse({ ...samples.Flags, [key]: true }).success).toBe(false);
    }
    const { approvals: _, ...missing } = samples.Flags;
    expect(flags.FlagsSchema.safeParse(missing).success).toBe(false);
  });
  it('freezes §21.1 topics and uses distinct valid Postgres identifiers', () => {
    expect(contracts.BUS_TOPICS).toEqual(['chain.block', 'chain.reorg', 'swap', 'pair.created', 'liquidity', 'pons.exempt', 'label.updated', 'card.updated', 'verdict.created', 'forecast.created', 'preflight.created', 'approval.updated', 'order.updated', 'burn.event', 'pons.buyback', 'receipt.committed']);
    const channels = contracts.BUS_TOPICS.map(contracts.busChannel);
    expect(channels).toEqual(contracts.BUS_TOPICS.map((topic) => `eko_${topic.replaceAll('.', '_')}`));
    expect(new Set(channels).size).toBe(channels.length);
    for (const ch of channels) { expect(ch).toMatch(/^eko_[a-z_]+$/); expect(ch.length).toBeLessThan(64); }
  });
  it('exports the versions from one place', () => {
    expect(contracts.RECEIPT_SCHEMA_VERSIONS).toEqual({ verdict: 'verdict-1', forecast: 'forecast-1', harness_private: 'harness_private-1' });
  });
  it('uses §5.5 precedence and confidence boundaries', () => {
    expect(contracts.WALLET_LABEL_PRECEDENCE).toEqual(['declared_agent', 'crew', 'likely_agent', 'human']);
    for (const [value, tier] of [[1, 'high'], [0.9, 'high'], [0.899, 'medium'], [0.75, 'medium'], [0.749, 'low'], [0.6, 'low'], [0.599, undefined]] as const) {
      expect(contracts.labelTier(value)).toBe(tier);
    }
    expect(() => contracts.labelTier(1.01)).toThrow();
  });
});

describe('WebSocket channel/kind/payload correlations', () => {
  it('parses every event and rejects cross-channel kinds and invalid data', () => {
    for (const [channel, events] of Object.entries(samples.WsEventMap)) {
      const ch = channel === 'coin' || channel === 'flow' ? `${channel}:${samples.Address}` : channel;
      for (const [kind, data] of Object.entries(events)) {
        const event = { t: 'ev', ch, kind, data, seq: 1, ts: 1 };
        expect(contracts.WsServerSchema.parse(event)).toEqual(event);
        expect(contracts.WsEventSchema.safeParse({ ...event, kind: 'unknown' }).success).toBe(false);
        expect(contracts.WsEventSchema.safeParse({ ...event, data: null }).success).toBe(false);
        expect(contracts.WsEventSchema.safeParse({ ...event, ch: 'feed' === ch ? 'orders' : 'feed' }).success).toBe(false);
      }
    }
  });
  it('covers control frames, subscription operations, and address channel validation', () => {
    for (const frame of [
      { t: 'hello', serverTime: 1, session: 'anon', delayedSec: 0 },
      { t: 'hello', serverTime: 1, session: 'user', delayedSec: 0 },
      { t: 'ack', ch: 'radar', seq: 1 }, { t: 'resync', ch: 'radar' }, { t: 'pong', serverTime: 1 },
      { t: 'err', code: 'forbidden', message: 'fixture', ch: 'orders' },
    ]) expect(contracts.WsServerSchema.parse(frame)).toEqual(frame);
    for (const frame of [{ op: 'sub', ch: ['radar'] }, { op: 'unsub', ch: ['radar'] }, { op: 'ping' }]) expect(contracts.WsClientSchema.parse(frame)).toEqual(frame);
    for (const ch of ['coin', 'flow', 'coin:0x12', 'flow:0xzz', 'unknown']) expect(contracts.WsChannelSchema.safeParse(ch).success).toBe(false);
    expect(contracts.WsChannelSchema.parse(`coin:0x${'AB'.repeat(20)}`)).toBe(`coin:${samples.Address}`);
  });
  it('exports correlated TypeScript event types', () => {
    expectTypeOf<Extract<WsEvent<'coin'>, { kind: 'tick' }>['data']>().toEqualTypeOf<WsEventMap['coin']['tick']>();
    expectTypeOf<Extract<WsEvent<'approvals'>, { kind: 'approval' }>['data']>().toEqualTypeOf<contracts.Approval>();
    expectTypeOf<Address>().toEqualTypeOf<`0x${string}`>();
    // @ts-expect-error coin events cannot use an order payload/kind.
    const invalid: WsEvent<'coin'> = { t: 'ev', ch: `coin:${samples.Address}`, kind: 'order', data: samples.TradeOrder, seq: 1, ts: 1 };
    void invalid;
  });
});

describe('CA-32 structured Feed description fields', () => {
  it('are optional, typed and keep agent-supplied text untrusted', async () => {
    const { FeedItemSchema } = await import('../src/index.js');
    const base = { id: 'f1', ts: 1, block: 1, kind: 'agent_trade', coin: `0x${'ab'.repeat(20)}`, symbol: { text: '$ZEST', truncated: false, flags: [] } };
    expect(FeedItemSchema.safeParse(base).success).toBe(true);
    const full = { ...base, side: 'sell', agentName: { text: 'Quiet Otter', truncated: false, flags: [] }, crewName: 'Night Shift', crewWallets: 13,
      matchPct: 94, cloneOf: { text: '$EKO', truncated: false, flags: ['impersonation'] }, clones7d: 6, firstVerdictMs: 4100, swarm: { pass: 7, of: 9 } };
    expect(FeedItemSchema.parse(full)).toEqual(full);
    expect(FeedItemSchema.safeParse({ ...base, side: 'hold' }).success).toBe(false);
    expect(FeedItemSchema.safeParse({ ...base, agentName: 'Quiet Otter' }).success).toBe(false);
    expect(FeedItemSchema.safeParse({ ...base, matchPct: 101 }).success).toBe(false);
    expect(FeedItemSchema.safeParse({ ...base, swarm: { pass: 1, of: 0 } }).success).toBe(false);
  });
});

describe('which match leads a row', () => {
  it('puts Danger before Monitor in rule order and never an Info observation', () => {
    const m = (id: string, level: 'info' | 'monitor' | 'danger') => ({ id, level });
    const { findingsFirst, isHardDanger, HARD_DANGER_PLAYBOOKS, PlaybookIdSchema } = contracts;
    expect(findingsFirst([m('tax_trap', 'info'), m('exempt_insiders', 'info')])).toEqual([]);
    expect(findingsFirst([m('tax_trap', 'info'), m('bundle_dump', 'monitor'), m('holder_concentration', 'monitor'), m('run_up', 'danger')]).map(x => x.id)).toEqual(['run_up', 'bundle_dump', 'holder_concentration']);
    expect(isHardDanger('honeypot')).toBe(true); expect(isHardDanger('run_up')).toBe(false);
    for (const id of HARD_DANGER_PLAYBOOKS) expect(PlaybookIdSchema.options).toContain(id);
  });
});
describe('CA-31 (proposed) signal, sparkline and agent split', () => {
  const signal = { composite: 72, readings: { momentum: 86, liquidity: 80, holders: 58, narrative: 70, risk: 44 },
    weights: { momentum: 0.3, liquidity: 0.25, holders: 0.2, narrative: 0.15, risk: 0.1 }, beta: true as const, asOfBlock: 1 };
  it('is optional and validated', async () => {
    const { CoinSignalSchema, RadarRowSchema } = await import('../src/index.js');
    expect(CoinSignalSchema.safeParse(signal).success).toBe(true);
    expect(CoinSignalSchema.safeParse({ ...signal, composite: 101 }).success).toBe(false);
    expect(CoinSignalSchema.safeParse({ ...signal, beta: false }).success).toBe(false);
    expect(CoinSignalSchema.safeParse({ ...signal, lowData: ['narrative'] }).success).toBe(true);
    expect(CoinSignalSchema.safeParse({ ...signal, lowData: ['swarm'] }).success).toBe(false);
    expect(RadarRowSchema.shape.signal.isOptional()).toBe(true);
    expect(RadarRowSchema.shape.spark8h.safeParse(Array.from({ length: 128 }, () => 1)).success).toBe(true);
    expect(RadarRowSchema.shape.spark8h.safeParse(Array.from({ length: 129 }, () => 1)).success).toBe(false);
  });
});
