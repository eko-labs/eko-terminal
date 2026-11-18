// Copy for the public trust pages: /official, /transparency and /security.
// Only verified facts are stated as facts. Anything the owner has not published or confirmed is shown as
// "Not published yet" or "Pending owner confirmation", never as a placeholder that looks real.
// One build serves one chain (lib/chain.ts): wording that names a chain or a launchpad is kept per chain below, and the
// Robinhood build leaves out what its light service does not have (no receipts registry and no registry wallets).
import type { ChainKey } from '@eko/shared';
import { pick } from '../lib/chain';

/**
 * Where EKO's Elysium deployment would live. Elysium is shelved (2026-11-17: its service is stopped, its data kept), so
 * no page links here; the value is kept for when it returns.
 */
export const ELYSIUM_SITE = 'https://elysium.ekoterminal.com';

/** Verified public links (checked 2026-11-16: public repository eko-labs/eko-terminal, private vulnerability reporting enabled). */
export const PROJECT_LINKS = {
  site: 'https://ekoterminal.com',
  elysiumSite: ELYSIUM_SITE,
  repo: 'https://github.com/eko-labs/eko-terminal',
  advisory: 'https://github.com/eko-labs/eko-terminal/security/advisories/new',
  findings: 'https://github.com/eko-labs/eko-terminal/blob/main/contracts/review/findings.yaml',
  securityPolicy: 'https://github.com/eko-labs/eko-terminal/blob/main/SECURITY.md',
  /** Role mailbox; forwarding confirmed by the owner on 2026-10-04. */
  mailbox: 'security@ekoterminal.com',
  /** Served by the API, not an SPA route. */
  securityTxt: '/.well-known/security.txt',
} as const;

export const NO_TOKEN = 'We have no token yet; any token claiming to be EKO is fake.';
export const NOT_PUBLISHED = 'Not published yet';
export const PENDING_OWNER = 'Pending owner confirmation';

export const TRUST_COPY = {
  eyebrow: 'Trust',
  nav: 'Project evidence',
  official: 'Official project links',
  transparency: 'Transparency',
  security: 'Security',
  scoreboard: 'Scoreboard',
  policies: 'Launch policies',
  warningTitle: 'No token yet',
  warning: [
    NO_TOKEN,
    'EKO never needs your seed phrase or private keys: your own wallet signs everything. We never DM first.',
  ],
} as const;

type Item = { readonly label: string; readonly note: string };
type Lines = readonly string[];
export interface OfficialCopy {
  intro: string; verifiedTitle: string; verified: readonly (Item & { text: string; href: string })[];
  unpublishedTitle: string; unpublishedIntro: string; unpublished: readonly Item[];
}
export interface TransparencyCopy {
  walletsTitle: string; walletsIntro: string; wallets: readonly Item[]; feesTitle: string; fees: Lines; reviewTitle: string; review: Lines;
  findingsLink: string; tokenTitle: string; token: Lines; checkTitle: string; check: Lines;
}
export interface SecurityCopy {
  statusTitle: string; status: Lines; reportTitle: string; channels: readonly { label: string; text: string; href: string }[]; report: Lines;
  scopeTitle: string; scope: Lines; outTitle: string; out: Lines; rulesTitle: string; rules: Lines; goodFaithTitle: string; goodFaith: Lines;
  fullPolicy: string;
}

const VERIFIED_COMMON = [
  { label: 'Source code', text: 'github.com/eko-labs/eko-terminal', href: PROJECT_LINKS.repo, note: 'Public repository.' },
  { label: 'Security email', text: PROJECT_LINKS.mailbox, href: `mailto:${PROJECT_LINKS.mailbox}`, note: 'Role mailbox for private vulnerability reports.' },
  { label: 'Private report on GitHub', text: 'Report a vulnerability', href: PROJECT_LINKS.advisory, note: 'GitHub private vulnerability reporting for the public repository.' },
  { label: 'Security contact file', text: 'security.txt', href: PROJECT_LINKS.securityTxt, note: 'Machine-readable contact details.' },
] as const;
const OFFICIAL_INTRO = { intro: 'If a link, account or address is not on this page, treat it as unofficial.', verifiedTitle: 'Verified links' } as const;
const UNPUBLISHED_INTRO = {
  unpublishedTitle: 'Not published yet',
  unpublishedIntro: 'Each item below will be added here when the owner publishes it. Until then, anything claiming to be one of these is not ours.',
} as const;

export const OFFICIAL_BY_CHAIN: Readonly<Record<ChainKey, OfficialCopy>> = {
  elysium: {
    ...OFFICIAL_INTRO,
    verified: [{ label: 'Website', text: 'ekoterminal.com', href: PROJECT_LINKS.site, note: 'The terminal and these pages.' }, ...VERIFIED_COMMON],
    ...UNPUBLISHED_INTRO,
    unpublished: [
      { label: 'EKO token contract', note: 'There is no EKO token yet.' },
      { label: 'Receipts registry contract', note: 'Elysium address.' },
      { label: 'Registry owner and committer wallets', note: 'Elysium addresses.' },
      { label: 'Dev fee wallet', note: 'Elysium address.' },
      { label: 'X, Telegram and Farcaster accounts', note: 'Account names.' },
      { label: 'Status page', note: 'Web address.' },
    ],
  },
  robinhood: {
    ...OFFICIAL_INTRO,
    verified: [
      { label: 'Website', text: 'ekoterminal.com', href: PROJECT_LINKS.site, note: 'The terminal and these pages.' },
      ...VERIFIED_COMMON,
    ],
    ...UNPUBLISHED_INTRO,
    unpublished: [
      { label: 'EKO token contract', note: 'There is no EKO token yet.' },
      { label: 'Dev fee wallet', note: 'Robinhood Chain address.' },
      { label: 'X, Telegram and Farcaster accounts', note: 'Account names.' },
      { label: 'Status page', note: 'Web address.' },
    ],
  },
};

const FEE_NOTICE = 'If EKO starts charging a fee, it will be announced before it starts and shown in every quote before you sign.';
const REVIEW = {
  reviewTitle: 'Contract review',
  review: [
    'AI-assisted and automated review, not a professional audit.',
    'Every finding and its status is in the findings log.',
    'On-chain guardrails stay advisory until their configuration passes review.',
  ],
  findingsLink: 'Read the findings log',
  tokenTitle: 'Token',
  token: [
    NO_TOKEN,
    'If a token is planned, it will be announced here first.',
  ],
} as const;
const DEV_WALLET = { label: 'Dev fee wallet', note: 'Receives any creator fees and pays running costs.' } as const;
const COSTS_NOTE = 'Running costs are planned to be listed in a monthly note.';

export const TRANSPARENCY_BY_CHAIN: Readonly<Record<ChainKey, TransparencyCopy>> = {
  elysium: {
    walletsTitle: 'Project wallets and contracts',
    walletsIntro: 'Every project wallet and contract will be public. None has been published yet, so no address is shown here.',
    wallets: [
      { label: 'Receipts registry', note: 'A contract on Elysium that records hashes of EKO’s published calls, so anyone can check them later. It holds no funds.' },
      { label: 'Registry owner', note: 'A cold wallet that can only change the registry’s settings, such as replacing the committer.' },
      { label: 'Registry committer', note: 'A hot wallet that posts new hashes to the registry. It holds gas only.' },
      DEV_WALLET,
    ],
    feesTitle: 'Fees',
    fees: [
      'EKO charges no fee on trades right now. Network gas and Montra’s own fees still apply.',
      FEE_NOTICE,
    ],
    ...REVIEW,
    checkTitle: 'Check it yourself',
    check: [
      'Once addresses are published, you can check them on the Elysium explorer: the registry’s owner and committer, the source commit, and that the deployed code matches the reviewed code.',
      COSTS_NOTE,
    ],
  },
  robinhood: {
    walletsTitle: 'Project wallets and contracts',
    walletsIntro: 'Every project wallet and contract will be public. None has been published yet, so no address is shown here. EKO has no contract of its own on Robinhood Chain.',
    wallets: [DEV_WALLET],
    feesTitle: 'Fees',
    fees: [
      'EKO charges no fee on trades right now. Network gas, Pons’s own fees and a coin’s own taxes still apply.',
      FEE_NOTICE,
    ],
    ...REVIEW,
    checkTitle: 'Check it yourself',
    check: [
      'Once the dev fee wallet is published, you can check its activity on Robinhood Chain’s Blockscout explorer. Every release’s source is in the public repository.',
      COSTS_NOTE,
    ],
  },
};

const SECURITY_COMMON = {
  statusTitle: 'Reporting is open',
  status: [
    'You can report a vulnerability now through either private channel below.',
    'There is no bug bounty, and EKO does not pay for reports.',
  ],
  reportTitle: 'How to report privately',
  channels: [
    { label: 'Email', text: PROJECT_LINKS.mailbox, href: `mailto:${PROJECT_LINKS.mailbox}` },
    { label: 'GitHub', text: 'Report a vulnerability (private)', href: PROJECT_LINKS.advisory },
  ],
  report: [
    'Never post a vulnerability in a public issue, chat or social post.',
    'Include what is affected (file, commit or contract), the impact, steps to reproduce, and a minimal proof of concept on a local copy or a fork.',
    'Do not send private keys, passwords or anyone else’s data.',
    'We aim to acknowledge every report within 48 hours.',
  ],
  scopeTitle: 'In scope',
} as const;
const SECURITY_RULES = {
  outTitle: 'Out of scope',
  rulesTitle: 'Rules for testing',
  rules: [
    'Test on local copies, forks, or accounts and wallets you control.',
    'Do not disrupt the live service, move anyone else’s funds or access their data. If you come across someone else’s data, stop and tell us.',
    'Give us time to fix an issue before you disclose it. We will agree the disclosure with you.',
  ],
  goodFaithTitle: 'Good-faith research',
  goodFaith: [
    'Proposed: if you follow this policy in good faith, EKO will not take legal action against you for that research or ask anyone else to. This covers only systems EKO controls.',
  ],
  fullPolicy: 'Full policy in the repository (SECURITY.md)',
} as const;
const OUT_COMMON = ['Social engineering, phishing and physical attacks.', 'Denial of service, spam and load testing.'] as const;

export const SECURITY_BY_CHAIN: Readonly<Record<ChainKey, SecurityCopy>> = {
  elysium: {
    ...SECURITY_COMMON,
    scope: [
      'The receipts registry contract on Elysium (address not published yet).',
      'The code in the public repository, github.com/eko-labs/eko-terminal, including the pre-trade guard (a bypass that lets a honeypot fill is Critical), the receipts verifier, wallet sign-in (SIWE), agent harness keys and the connector’s OAuth server.',
      'New contracts join the scope only when they are published.',
    ],
    ...SECURITY_RULES,
    out: ['Third-party contracts and services EKO builds on: Montra, Uniswap, multisig wallets and Zodiac modules.', ...OUT_COMMON],
  },
  robinhood: {
    ...SECURITY_COMMON,
    scope: [
      'The code in the public repository, github.com/eko-labs/eko-terminal, including the pre-trade guard (a bypass that lets a honeypot fill is Critical), wallet sign-in (SIWE), agent harness keys and the connector’s OAuth server.',
      'EKO has no contract of its own on Robinhood Chain. New contracts join the scope only when they are published.',
    ],
    ...SECURITY_RULES,
    out: ['Third-party contracts and services EKO builds on: Pons, Uniswap, Robinhood Chain itself, multisig wallets and Zodiac modules.', ...OUT_COMMON],
  },
};

export const OFFICIAL_COPY = pick(OFFICIAL_BY_CHAIN);
export const TRANSPARENCY_COPY = pick(TRANSPARENCY_BY_CHAIN);
export const SECURITY_COPY = pick(SECURITY_BY_CHAIN);
