// Copy for the public trust pages: /official, /transparency and /security.
// Only verified facts are stated as facts. Anything the owner has not published or confirmed is shown as
// "Not published yet" or "Pending owner confirmation", never as a placeholder that looks real.

/** Verified public links (checked 2026-10-05: public repository, private vulnerability reporting enabled). */
export const PROJECT_LINKS = {
  site: 'https://ekoterminal.com',
  repo: 'https://github.com/EkoTerminal/eko',
  advisory: 'https://github.com/EkoTerminal/eko/security/advisories/new',
  findings: 'https://github.com/EkoTerminal/eko/blob/main/contracts/review/findings.yaml',
  securityPolicy: 'https://github.com/EkoTerminal/eko/blob/main/SECURITY.md',
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

export const OFFICIAL_COPY = {
  intro: 'If a link, account or address is not on this page, treat it as unofficial.',
  verifiedTitle: 'Verified links',
  verified: [
    { label: 'Website', text: 'ekoterminal.com', href: PROJECT_LINKS.site, note: 'The terminal and these pages.' },
    { label: 'Source code', text: 'github.com/EkoTerminal/eko', href: PROJECT_LINKS.repo, note: 'Public repository.' },
    { label: 'Security email', text: PROJECT_LINKS.mailbox, href: `mailto:${PROJECT_LINKS.mailbox}`, note: 'Role mailbox for private vulnerability reports.' },
    { label: 'Private report on GitHub', text: 'Report a vulnerability', href: PROJECT_LINKS.advisory, note: 'GitHub private vulnerability reporting for the public repository.' },
    { label: 'Security contact file', text: 'security.txt', href: PROJECT_LINKS.securityTxt, note: 'Machine-readable contact details.' },
  ],
  unpublishedTitle: 'Not published yet',
  unpublishedIntro: 'Each item below will be added here when the owner publishes it. Until then, anything claiming to be one of these is not ours.',
  unpublished: [
    { label: 'EKO token contract', note: 'There is no EKO token yet.' },
    { label: 'Receipts registry contract', note: 'Elysium address.' },
    { label: 'Registry owner and committer wallets', note: 'Elysium addresses.' },
    { label: 'Dev fee wallet', note: 'Elysium address.' },
    { label: 'X, Telegram and Farcaster accounts', note: 'Account names.' },
    { label: 'Status page', note: 'Web address.' },
  ],
} as const;

export const TRANSPARENCY_COPY = {
  walletsTitle: 'Project wallets and contracts',
  walletsIntro: 'Every project wallet and contract will be public. None has been published yet, so no address is shown here.',
  wallets: [
    { label: 'Receipts registry', note: 'A contract on Elysium that records hashes of EKO’s published calls, so anyone can check them later. It holds no funds.' },
    { label: 'Registry owner', note: 'A cold wallet that can only change the registry’s settings, such as replacing the committer.' },
    { label: 'Registry committer', note: 'A hot wallet that posts new hashes to the registry. It holds gas only.' },
    { label: 'Dev fee wallet', note: 'From token day, receives the creator fees and pays running costs.' },
  ],
  feesTitle: 'Fees',
  fees: [
    'Terminal fee: 0% during launch week. Network, venue and token fees still apply.',
    'From token day, any terminal fee will be published before it starts. Pons-curve trades carry no terminal fee at launch.',
  ],
  reviewTitle: 'Contract review',
  review: [
    'AI-assisted and automated review, not a professional audit.',
    'Planned public code review: October 13, 2026, 13:00 UTC to October 16, 2026, 13:00 UTC. If a High or Medium issue is fixed during the window, the full 72 hours start again.',
    'Findings as of October 5, 2026: three open (two Low, one Info), none High or Critical.',
    'On-chain guardrails stay advisory until their configuration passes review.',
  ],
  findingsLink: 'Read the findings log',
  tokenTitle: 'Token day',
  token: [
    NO_TOKEN,
    'A token is planned for October 20, 2026, and only if every public gate passes: zero honeypot fills, evaluation gates green and the receipts registry review done. If a gate fails, the token waits.',
  ],
  checkTitle: 'Check it yourself',
  check: [
    'Once addresses are published, you can check them on the Elysium explorer: the registry’s owner and committer, the source commit, and that the deployed code matches the reviewed code.',
    'Running costs are planned to be listed in a monthly note.',
  ],
} as const;

export const SECURITY_COPY = {
  statusTitle: 'Reporting is open',
  status: [
    'You can report a vulnerability now through either private channel below.',
    'There is no bug bounty, and EKO does not pay for reports.',
    'The public code review is planned to start on October 13, 2026, at 13:00 UTC.',
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
  scope: [
    'The receipts registry contract on Elysium (address not published yet).',
    'The code in the public repository, github.com/EkoTerminal/eko, including the pre-trade guard (a bypass that lets a honeypot fill is Critical), the receipts verifier, wallet sign-in (SIWE), agent harness keys and the connector’s OAuth server.',
    'New contracts join the scope only when they are published.',
  ],
  outTitle: 'Out of scope',
  out: [
    'Third-party contracts and services EKO builds on: Pons, Uniswap, multisig wallets and Zodiac modules.',
    'Robinhood’s apps, brokerage and accounts.',
    'Social engineering, phishing and physical attacks.',
    'Denial of service, spam and load testing.',
  ],
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
