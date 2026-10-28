import type { PlaybookId } from '@eko/shared';

/** First-party one-line copy; never use token descriptions or free-text event details. */
export const PLAYBOOK_DESCRIPTIONS: Record<PlaybookId, string> = {
  honeypot: 'Buys go through; sells revert or return almost nothing.',
  tax_trap: 'The owner can raise the sell tax after you buy.',
  removable_liquidity: 'The deployer controls the pool and can pull it.',
  fee_trap_pool: 'The default route runs through a pool charging 15% or more.',
  stuck_at_bonding: 'Heavy volume that never moves the curve; a few wallets cycling.',
  wash_to_trend: 'Volume made by wallets trading with themselves.',
  clone_swarm: 'Copies the name of a trending coin launched earlier.',
  exempt_insiders: 'Anti-sniper-exempt wallets bought a large share of supply.',
  bundle_dump: 'Wallets that bought in the first minute (bundles, snipers, the deployer) took a large share.',
  migration_dump: 'Insiders sold into graduation.',
  malicious_hook: 'A v4 hook charges sells more than buys.',
  agent_bait: 'Token text carries instructions aimed at AI agents',
  serial_deployer: 'This deployer has launched coins that matched playbooks before.',
  holder_concentration: 'A few wallets hold a large share, or hold tokens they never bought.',
  dev_dump: 'The deployer sold on buyers fast, or still holds a large bag.',
  run_up: 'Much of the supply is already bought off the curve; late buyers pay far above the start.',
  launch_snipers: 'Bots bought within a second of launch, often outbidding on priority fees, and can dump on later buyers.',
};
