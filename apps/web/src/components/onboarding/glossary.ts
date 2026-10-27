import { PAPER_STARTING_CASH } from '@eko/shared';
import type { TermId } from './Term';

/**
 * The single source for every plain-English definition in EKO: inline <Term> tooltips,
 * the help centre glossary and the tour all read from here. Keep entries short, true and
 * free of promises (see docs/ARCHITECTURE.md and docs/BUSINESS_MODEL.md).
 */
export interface GlossaryEntry {
  term: string;
  /** One or two sentences: shown in the tooltip. */
  short: string;
  /** Optional extra detail for the help centre. */
  more?: string;
  /** Extra words people might search for. */
  aka?: string[];
}

const cash = `$${PAPER_STARTING_CASH.toLocaleString('en-US')}`;

export const GLOSSARY: Record<TermId, GlossaryEntry> = {
  rule_lab: {
    term: 'Rule Lab',
    short: 'Compile standing instructions into rules, then test them on historical data with costs included.',
    aka: ['backtest', 'rules', 'standing instructions'],
  },
  paper: {
    term: 'Paper trading',
    short: `The default. ${cash} of paper money, filled at the live bid/ask with a 0.10% modelled fee. No real funds, nothing on-chain.`,
    more: 'Paper balances are a simulation stored by EKO. They are not assets and are kept separate from live records.',
    aka: ['simulated', 'demo', 'practice'],
  },
  live: {
    term: 'Live trading',
    short: 'Real swaps on Elysium mainnet (chain 99901) through Uniswap v4, signed by your own wallet. Trading from EKO opens after launch; until then checks and charts are live.',
    more: 'EKO never holds your funds or keys. A live order is “submitted” when your wallet broadcasts it and only “confirmed” once the receipt is reconciled.',
    aka: ['real funds', 'mainnet', 'on-chain'],
  },
  slippage: {
    term: 'Slippage',
    short: 'How far the price may move against you before a trade fills. You set the limit in Settings.',
    more: 'On-chain, a swap that would fill beyond your limit reverts instead of filling worse.',
    aka: ['tolerance', 'minimum received'],
  },
  gas: {
    term: 'Gas',
    short: 'The network fee for an on-chain transaction, paid in HYPE on Elysium. Transactions are ordered by priority fee, so launch-block trades can cost more.',
    aka: ['network fee', 'fees'],
  },
  usdg: {
    term: 'HYPE',
    short: 'Hyperliquid’s token and Elysium’s gas token. Most Elysium launches trade against native HYPE.',
    aka: ['whype', 'gas token', 'hyperliquid'],
  },
  approval: {
    term: 'Token approval',
    short: 'Before a swap can spend your USDG, your wallet approves the Uniswap router for the exact amount of that trade — never an unlimited allowance.',
    aka: ['allowance', 'approve'],
  },
  spot_only: {
    term: 'Spot only',
    short: 'You trade assets you actually hold. There is no shorting, so you can only sell an asset you already own.',
    aka: ['short', 'shorting', 'sell'],
  },
};

/** Help-centre-only entries (not used as inline terms). */
export const EXTRA_TERMS: GlossaryEntry[] = [
  {
    term: 'One-tap trade',
    short: 'Buy or Sell trades the amount you picked, right away. A sell never exceeds what you hold; if that’s worth less, it sells all of it.',
    aka: ['instant', 'buy', 'sell', 'amount', 'preset', 'close', 'sell all'],
  },
  {
    term: 'Quote',
    short: 'The executable price at the moment you tap: the live bid/ask on Paper, the Uniswap pool on Live.',
    aka: ['price', 'bid', 'ask'],
  },
  {
    term: 'Submitted vs confirmed',
    short: 'Live only. “Submitted” means your wallet broadcast the transaction; it becomes “confirmed” only after EKO checks the on-chain receipt.',
    aka: ['pending', 'receipt', 'transaction'],
  },
  {
    term: 'Sign-In With Ethereum',
    short: 'A free signature that proves you own your wallet. It doesn’t authorise any transaction or spending.',
    aka: ['siwe', 'verify', 'sign in'],
  },
  {
    term: 'Elysium',
    short: 'Kinetiq’s Arbitrum Orbit layer-2 for Hyperliquid, settling to HyperEVM. EKO is an independent app on it — not a Kinetiq or Hyperliquid product.',
    aka: ['chain 99901', 'l2', 'kinetiq', 'hyperliquid'],
  },
];

export const ALL_TERMS: (GlossaryEntry & { id: string })[] = [
  ...(Object.entries(GLOSSARY) as [TermId, GlossaryEntry][]).map(([id, e]) => ({ id, ...e })),
  ...EXTRA_TERMS.map((e) => ({ id: e.term.toLowerCase().replace(/[^a-z0-9]+/g, '-'), ...e })),
].sort((a, b) => a.term.localeCompare(b.term));

/** Case-insensitive search across term, definition and synonyms. */
export function searchTerms(q: string): (GlossaryEntry & { id: string })[] {
  const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ALL_TERMS;
  return ALL_TERMS.filter((e) => {
    const hay = `${e.term} ${e.short} ${e.more ?? ''} ${(e.aka ?? []).join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
