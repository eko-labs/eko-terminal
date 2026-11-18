import type { ChainKey, RadarRow } from '@eko/shared';
import { pick } from '../lib/chain';

/**
 * Chain and launchpad context, named the same way on every surface. One chain per build (VITE_EKO_CHAIN): Elysium
 * (native HYPE, Montra's price line marks graduation) or Robinhood Chain (native ETH, Pons coins trade on a bonding
 * curve until it fills, then in a Uniswap v4 pool with the Pons hook). Surfaces read CHAIN_COPY; CHAIN_COPY_BY_CHAIN is
 * exported so tests can read both builds' wording.
 */
export const CHAIN_COPY_BY_CHAIN = {
  elysium: {
    name: 'Elysium',
    title: 'Elysium · chain ID 99901',
    /** Status popover row label for the chain's RPC health. */
    network: 'Elysium',
    blueChipListing: 'Recognised elsewhere: a CoinGecko listing with an Elysium contract (chain 99901). Listing data from CoinGecko.',
    radarIntro: 'Every Montra launch on Elysium from the last 24 hours, checked by the guard, most traded first.',
    feedIntro: 'Trades, Fast Scans, playbook alerts and Ghost Reports across Elysium, as they happen.',
    pairsIntro: 'Every launch on Elysium gets a Fast Scan before it gets a Trade button.',
    pairs: {
      new: { sub: 'Under half way to graduation, newest first', about: 'Every launch on Elysium, from its first block. Nothing on Elysium has a bonding curve: each coin trades in its own Uniswap pool from launch, with its launch liquidity locked.' },
      near_grad: { sub: 'Half way or more, closest first', about: "Montra marks graduation as a line in the coin's own pool, at 16.8× its opening price. Nothing migrates when a coin passes it. Launchpads without a line of their own are measured against the same market cap." },
      migrated: { sub: 'Past the graduation line, latest first', about: "Coins past the graduation line: Montra's Graduated event, or the same market cap reached on another launchpad. They keep trading in the same pool." },
    },
    gradTitle: 'How far the coin is to the graduation line: 16.8× the opening price on Montra, or the same market cap on other launchpads.',
    /** The Pairs launchpad filter: the chain's own launchpad against everything else. */
    padFilter: { label: 'Montra', launchpad: 'montra' as RadarRow['launchpad'] },
    deployerLaunches: 'on Elysium',
    deployerNoFunder: 'No incoming HYPE transfer funded this wallet (it may have bridged in).',
    deployerCoverage: "Elysium's first Montra launch",
    censusFlow: 'Wallet-labelled buy flow on Elysium.',
    censusFirst: 'Per our research, the first agent-flow metric published for Elysium.',
    helpWhere: 'Elysium mainnet (99901), Uniswap v4 (trading opens later)',
    helpIndependent: 'EKO is an independent app on Elysium — not a Kinetiq or Hyperliquid product.',
    rpcUnavailable: 'Elysium isn’t responding — try again shortly',
  },
  robinhood: {
    name: 'Robinhood Chain',
    title: 'Robinhood Chain · chain ID 4663',
    network: 'Robinhood Chain',
    blueChipListing: 'Recognised elsewhere: a CoinGecko listing with a Robinhood Chain contract (chain 4663). Listing data from CoinGecko.',
    radarIntro: 'Every live coin on Robinhood Chain, from Pons launches to Uniswap pools, checked by the guard, most traded first.',
    feedIntro: 'Trades, Fast Scans, playbook alerts and Ghost Reports across Robinhood Chain, as they happen.',
    pairsIntro: 'Every Pons launch and new Uniswap pool on Robinhood Chain gets a Fast Scan before it gets a Trade button.',
    pairs: {
      new: { sub: 'Under 30% of the way to graduation, newest first', about: 'Pairs still on the Pons bonding curve, and coins that launched straight into a Uniswap pool. A Pons launch starts with a decaying anti-sniper tax.' },
      near_grad: { sub: '30% of the way or more, closest first', about: 'A Pons coin trades on its bonding curve until the curve fills. At 100% it graduates: its liquidity moves to a Uniswap v4 pool with the Pons hook. The guard rescans at graduation.' },
      migrated: { sub: 'Graduated to a pool, latest first', about: 'Pons coins whose curve filled and that now trade in their Uniswap v4 pool. Trading routes and fees appear in the guarded panel.' },
    },
    gradTitle: 'How far the coin is to graduation: a Pons coin graduates when its bonding curve fills; other launchpads are measured against the same market cap.',
    padFilter: { label: 'Pons', launchpad: 'pons' as RadarRow['launchpad'] },
    deployerLaunches: 'on Robinhood Chain',
    deployerNoFunder: 'No incoming ETH transfer funded this wallet (it may have bridged in).',
    deployerCoverage: "Robinhood Chain's first Pons launch",
    censusFlow: 'Wallet-labelled buy flow on Robinhood Chain.',
    censusFirst: 'Per our research, the first agent-flow metric published for Robinhood Chain.',
    helpWhere: 'Robinhood Chain mainnet (4663), the Pons curve, then Uniswap v4',
    helpIndependent: 'EKO is an independent app on Robinhood Chain — not a Robinhood Markets product.',
    rpcUnavailable: 'Robinhood Chain isn’t responding — try again shortly',
  },
} as const satisfies Record<ChainKey, unknown>;
export const CHAIN_COPY = pick<(typeof CHAIN_COPY_BY_CHAIN)[ChainKey]>(CHAIN_COPY_BY_CHAIN);

export const CHAIN_NAME = CHAIN_COPY.name;
export const CHAIN_TITLE = CHAIN_COPY.title;

type Launchpad = RadarRow['launchpad'];
// Pairs, the coin view and the stage filter treat every non-launchpad pool as Uniswap. These label data values, so
// both builds carry every launchpad: a label shows only when the server reports that launchpad.
const LAUNCHPAD_LABELS: Record<Launchpad, string> = { pons: 'Pons', occupy: 'Occupy', flap: 'Flap', klik: 'Klik', montra: 'Montra', flaunch: 'Flaunch fork', hyperforge: 'HyperForge', taxlaunch: 'Tax launchpad', unbranded: 'Unbranded launcher', other: 'Uniswap' };
/** "Pons", "Pons → pool" once a Pons coin has migrated, or the pool venue for everything else. */
export function launchpadLabel(launchpad: Launchpad, migrated = false) {
  return launchpad === 'pons' && migrated ? 'Pons → pool' : LAUNCHPAD_LABELS[launchpad] ?? 'Uniswap';
}
