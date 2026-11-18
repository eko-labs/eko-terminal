import type { TradeOrder } from '@eko/shared';
import { pick } from '../lib/chain';

/** The native coin a trade pays or receives on this build's chain. */
const NATIVE = pick({ elysium: 'HYPE', robinhood: 'ETH' });
const EXPLORER = pick({ elysium: 'the Elysium explorer', robinhood: 'Blockscout' });

/** Copy for /orders, the signed-in wallet's order history. */
export const ORDERS_COPY = {
  title: 'Orders',
  nav: 'Orders',
  intro: `Every order you placed from your own wallet through EKO, newest first. Amounts are what the chain settled, in ${NATIVE} and in the coin.`,
  native: NATIVE,
  /** Table headings, in column order. */
  cols: { time: 'Time', coin: 'Coin', side: 'Side', native: NATIVE, coin_amount: 'Coin amount', status: 'Status', tx: 'Transaction' },
  caption: 'Your orders, newest first',
  side: { buy: 'Buy', sell: 'Sell' } satisfies Record<TradeOrder['side'], string>,
  status: {
    awaiting_signature: 'Awaiting signature', submitted: 'Pending', confirmed: 'Filled',
    failed: 'Failed', rejected: 'Not signed', expired: 'Expired',
  } satisfies Record<TradeOrder['status'], string>,
  /** Why an order did not fill, by the server's error code. Unknown codes show the status alone. */
  errors: {
    not_mined: 'Not mined within 15 minutes',
    reverted: 'Reverted on chain',
    user_rejected: 'Rejected in your wallet',
    signing_failed: 'Your wallet could not sign',
  } as Record<string, string>,
  paid: 'paid', received: 'received',
  noFill: '—',
  noFillTitle: 'Nothing settled on chain for this order.',
  unnamed: 'Unknown coin',
  txLink: (hash: string) => `View transaction ${hash} on ${EXPLORER}`,
  explorer: EXPLORER,
  noTx: 'No transaction',
  pending: (n: number) => `${n} ${n === 1 ? 'order is' : 'orders are'} waiting for the chain. This list refreshes until ${n === 1 ? 'it settles' : 'they settle'}.`,
  count: (n: number) => `${n} ${n === 1 ? 'order' : 'orders'}`,
  loading: 'Loading your orders…',
  emptyTitle: 'No orders yet',
  empty: 'Orders you place from your wallet show up here, with what was paid and received and a link to the transaction.',
  emptyCta: 'Find a coin on Radar',
  error: 'Could not load your orders.',
  retry: 'Retry',
  refresh: 'Refresh',
  note: `Amounts are read from each transaction’s receipt. A buy pays ${NATIVE} and receives the coin; a sell pays the coin and receives ${NATIVE}.`,
} as const;
