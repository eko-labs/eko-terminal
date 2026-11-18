import { robinhood } from 'viem/chains';
import { elysium, ELYSIUM_EXPLORER, ELYSIUM_PUBLIC_RPC } from '@eko/chain';
import { CONFIG_V1, type PlaybookConfig } from '@eko/playbooks';
import { ELYSIUM_CHAIN_ID, NETWORKS, ROBINHOOD_CHAIN_ID } from '@eko/shared';
import type { ChainProfile } from './types.js';

const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info';

/**
 * The playbook settings: version 1, except that a single eth_call sell probe can reach Danger on its own. Version 1
 * waits for a deeper simulation from a plain wallet, which needs debug_trace; neither chain's public RPC has it. Montra
 * tokens are factory clones with no transfer code of their own, and every Pons token so far is one template, so a probe
 * that cannot sell is not a probe artefact. The same trade-off was accepted for Robinhood Chain (2026-11-17). Revisit
 * once a traced deep simulation is available.
 */
export const SINGLE_PROBE_PLAYBOOK_CONFIG: PlaybookConfig = { ...CONFIG_V1, honeypot: { minLossPct: 95, requireDeepSim: false } };
export const ELYSIUM_PLAYBOOK_CONFIG = SINGLE_PROBE_PLAYBOOK_CONFIG;

export const ELYSIUM_PROFILE: ChainProfile = {
  key: 'elysium', id: ELYSIUM_CHAIN_ID, name: 'Elysium', native: 'HYPE', chain: elysium,
  publicRpc: ELYSIUM_PUBLIC_RPC, explorerUrl: ELYSIUM_EXPLORER, explorerApi: `${ELYSIUM_EXPLORER}/api`,
  // ~98 ms blocks (measured 2026-11-11); the historian starts at the Montra factory's deployment.
  blockTimeSec: 0.098, tracker: { chunk: 2000 }, publicRpm: 600, historianFromBlock: 580_000,
  playbooks: ELYSIUM_PLAYBOOK_CONFIG, sniperBlocks: 10, nearGradBps: 5000, price: { url: HYPERLIQUID_INFO, symbol: 'HYPE' },
  venue: 'elysium', outcomeVersion: 'elysium-1', mcp: { name: 'eko-elysium', title: 'EKO (Elysium)' },
  text: { launches: 'Montra launches', token: 'Montra token', coins: 'Montra coins', earlyFee: "Montra's early-buy fee", tradeVenue: 'Uniswap v4' },
};

const rh = NETWORKS['robinhood-mainnet'];
/** Measured on the public endpoints on 2026-11-17 (docs/robinhood/CHAIN-FACTS.md, chains/robinhood/profile.ts). */
export const ROBINHOOD_PROFILE: ChainProfile = {
  key: 'robinhood', id: ROBINHOOD_CHAIN_ID, name: rh.name, native: 'ETH', chain: robinhood,
  // Blockscout answers scripts with a Cloudflare challenge (HTTP 403): no explorer API, so no historian by default.
  publicRpc: rh.publicRpcUrl, explorerUrl: rh.explorerUrl, explorerApi: null,
  // ~0.102 s blocks. Transfers run 4.6 to 8.1 a block against eth_getLogs' 10,000-result cap: spans start at 500 blocks,
  // and the start-up replay is 32,400 blocks (55 minutes). The historian would start at the Pons factory's deployment.
  // A graduate with 2.5 ETH (~$4.5k) or more traded in its last 24 hours stays in the Graduated column past a day.
  blockTimeSec: 0.102, tracker: { chunk: 500, backfillBlocks: 32_400, activeQuote24h: 2.5 },
  // Bursts of heavy eth_getLogs draw 429s, and the metered client then pauses the lane; 4 to 5 calls a second are safe.
  publicRpm: 270, historianFromBlock: 26_841_846,
  // 35 blocks (~3.5 s): Pons's anti-snipe tax runs 3 s (99%, 6.18%, 0.19%), so bots buy as it ends; the same first-35-block
  // window the Pons calibration (config v1, bundle_dump.firstBlocks) used for early-block buys.
  // About to graduate from 30% of the curve: a Pons curve spends most of its life under a third full, and the coins
  // traders watch for graduation (other terminals' "almost bonded") are the ones past it.
  playbooks: SINGLE_PROBE_PLAYBOOK_CONFIG, sniperBlocks: 35, nearGradBps: 3000, price: { url: HYPERLIQUID_INFO, symbol: 'ETH' },
  venue: 'rhc', outcomeVersion: 'robinhood-1', mcp: { name: 'eko-robinhood', title: 'EKO (Robinhood Chain)' },
  text: { launches: 'Pons launches', token: 'Pons token', coins: 'Pons coins', earlyFee: "Pons' launch snipe tax", tradeVenue: 'Pons curve or Uniswap v4' },
};
