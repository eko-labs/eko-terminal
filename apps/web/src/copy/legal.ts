import { ADVISORY, DYOR, NON_AFFILIATION, ONCHAIN_ADVISORY } from './index';

export interface PolicyDraft {
  slug: string;
  title: string;
  sections: readonly { title: string; paragraphs: readonly string[] }[];
}

// Approval is an external owner decision tied to an exact version, never inferred from a build.
// The owner approved Terms and Privacy on 2026-10-05, recorded in docs/public-launch/OWNER-DECISIONS.md (item 9).
export const POLICY_APPROVAL = {
  slugs: ['terms', 'privacy'],
  version: '2026-10-05',
  approvedAt: '2026-10-05',
  evidenceRef: 'docs/public-launch/OWNER-DECISIONS.md',
} as const;
export const isApprovedPolicy = (slug: string) => (POLICY_APPROVAL.slugs as readonly string[]).includes(slug);

// The other policies stay drafts until the owner approves them.
export const POLICY_REVIEW = {
  version: '2026-10-05-draft.3',
  draftedAt: '2026-10-05',
  effectiveAt: null,
  ownerApproval: { dueAt: '2026-10-05', approvedAt: null, evidenceRef: null },
} as const;

export const LEGAL_COPY = {
  navigation: 'Launch policies',
  draft: 'Draft — pending owner approval',
  review: 'This is a draft for the owner to review. It is not approved and not in effect. A review by legal counsel is planned for a later phase.',
  approved: 'Approved by the owner',
  approvedNote: 'A review by legal counsel is planned for a later phase.',
  missing: 'Policy not found',
  choose: 'Choose a policy below.',
  version: 'Version',
  drafted: 'Drafted',
  approvalDue: 'Owner approval due',
  approvalDate: 'Owner approval date',
  approvalEvidence: 'Approval evidence',
  pending: 'Pending — not approved yet',
  website: 'Website: ekoterminal.com',
  questions: 'Questions about these policies: contact the official EKO X or Telegram account, listed on',
  official: 'Official project links',
  security: 'Security reports: security@ekoterminal.com',
};

// TODO(spec): Server log and backup retention and the service-provider list are open owner decisions
// (docs/public-launch/OWNER-DECISIONS.md); the privacy policy says they will be published once confirmed.
// TODO(spec): Set the team blackout duration and exception-review procedure externally; no window is invented here.
export const POLICY_DRAFTS: readonly PolicyDraft[] = [
  { slug: 'terms', title: 'Terms of service', sections: [
    { title: 'What EKO is', paragraphs: [
      'EKO is a research terminal and a set of tools for Elysium. It shows chain data, risk checks and AI-generated analysis, lets you trade from your own wallet, and lets you connect your own trading agent so it checks with EKO before it places an order.',
      'EKO’s analysis is general research shared with every user. It is not investment advice and not a recommendation to buy or sell anything. You make your own decisions and you carry the risk of any loss.',
      DYOR,
    ] },
    { title: 'Your wallet, your keys', paragraphs: [
      'EKO is non-custodial. Your wallet signs every trade and every token approval, and approvals are for the exact amount of the trade. EKO’s servers never hold your private keys or your funds, and EKO never receives your Robinhood login details.',
      'Before you sign, check the token, amount, route, network and fees your wallet shows you. Network gas, venue fees, token taxes, slippage and failed transactions can all cost money.',
    ] },
    { title: 'Live trading', paragraphs: [
      'Live trading can be paused at any time, for example during an outage or while a required check is unavailable. While it is paused, you can still scan coins and paper trade.',
      'Live trades can be limited by a per-trade cap. EKO does not trade stocks, stock tokens or perpetual futures for you.',
      'Before EKO offers a live trade, it checks your trading wallet against the US Treasury’s OFAC sanctions list. If your wallet is listed, or the check cannot be completed, EKO does not offer the trade.',
    ] },
    { title: 'Fees', paragraphs: [
      'Terminal fee: 0% during launch week, until token day. Network, venue and token fees still apply.',
      'From token day, any terminal fee will be published before it starts. Pons-curve trades carry no terminal fee at launch.',
      'Planned tiers start the day after token day. EKO pays nothing to token holders.',
    ] },
    { title: 'Agents and guardrails', paragraphs: [
      ADVISORY,
      ONCHAIN_ADVISORY,
      'An agent can ignore an advisory check. EKO does not control your brokerage account; keep your brokerage’s own trade approvals on if you rely on them.',
    ] },
    { title: 'Fair use', paragraphs: [
      'Do not use EKO for anything unlawful, to evade sanctions, to attack or overload the service, or to interfere with other users.',
      'Token names, descriptions and links are written by strangers. EKO shows them as untrusted text; treat them that way too.',
    ] },
    { title: 'What can go wrong', paragraphs: [
      'Data can be missing, late or wrong. AI analysis can be wrong. Risk checks can miss harmful behavior. The service can slow down, pause or go offline. Check the live status before you act.',
    ] },
    { title: 'Robinhood', paragraphs: [
      'EKO runs on Elysium, a public blockchain.',
      NON_AFFILIATION,
    ] },
    { title: 'Changes', paragraphs: [
      'If these terms change, the new version will be posted on this page with a new version number and date.',
    ] },
  ] },
  { slug: 'privacy', title: 'Privacy policy', sections: [
    { title: 'The short version', paragraphs: [
      'EKO collects as little as it can. It never receives your Robinhood login details, your wallet’s private keys or your seed phrase. Wallet addresses and blockchain transactions are public by nature.',
    ] },
    { title: 'What EKO collects', paragraphs: [
      'Wallet sign-in: when you sign in with your wallet (Sign-In with Ethereum), EKO links your public wallet address to a session cookie. A wallet address is a public identifier, not an anonymous one.',
      'Things you save: your watchlist, alerts, settings, layouts and notes.',
      'Connected agents: if you connect a trading agent, EKO stores the agent, its settings, the checks it runs and its access keys. Keys are stored as keyed hashes, not in readable form.',
      'The Flight Recorder journal is opt-in. Private entries are encrypted with a key that belongs to your account. Only salted hashes of entries go into public receipts.',
      'Usage and speed: the app sends anonymous measurements, such as which screen loaded and how long it took. They are not linked to your wallet.',
      'Technical data: EKO’s servers process your IP address to limit abuse and keep the service running, and record errors so they can be fixed.',
      'Notifications: if you turn on browser notifications or link Telegram for alerts, EKO stores what it needs to send them.',
    ] },
    { title: 'Who else handles data', paragraphs: [
      'EKO uses service providers to run: hosting and database, blockchain data (RPC) providers, AI model providers for analysis, and error reporting. Private journal entries stay out of logs, analytics and share images. The list of providers will be published here once it is confirmed.',
    ] },
    { title: 'Sharing', paragraphs: [
      'Your journal is private. A separate opt-in to share de-identified outcomes is planned and is not available yet. Outcomes you choose to share would be kept indefinitely and could not be recalled.',
    ] },
    { title: 'Deleting your data', paragraphs: [
      'In Settings, under Privacy & data, “Delete my harness data” destroys the key that encrypts your journal, deletes your connected agents, journal, notes, settings and layouts, and revokes your agents’ keys and connector access. It cannot be undone.',
      'It keeps your sign-in record, your trade records and any public receipt hashes. Hashes already posted on-chain cannot be removed.',
    ] },
    { title: 'How long EKO keeps data', paragraphs: [
      'Planned retention: sessions 90 days; usage and speed measurements 30 days; bot interactions one year; AI analysis detail 180 days; audit logs two years. Agent journal and check records stay until you delete them, or 30 days after account deletion. Public chain data and receipts are kept permanently so they stay checkable.',
      'Server log and backup retention periods will be published here once they are confirmed.',
    ] },
    { title: 'Changes and contact', paragraphs: [
      'If this policy changes, the new version will be posted on this page with a new version number and date. For privacy questions, contact the official EKO X or Telegram account listed on the Official project links page (/official).',
    ] },
  ] },
  { slug: 'risk', title: 'Risk disclosure', sections: [
    { title: 'Loss and changing evidence', paragraphs: [
      'You can lose the entire amount of a trade. Liquidity can disappear, taxes or permissions can change, transactions can fail, and a token that was sellable can become unsellable. Simulation and playbook checks describe observed conditions and can miss harmful behavior. Missing or stale evidence remains unknown.',
      'Verdicts are live status and can change. No flags is not a recommendation. Refused and missed honeypot counts must be published from measured outcomes; missing counts are not zero. Forecasts and wallet labels are beta estimates, with confidence and limitations shown where available.',
      DYOR,
    ] },
    { title: 'Agent checks and control', paragraphs: [
      ADVISORY,
      'An agent can skip an advisory check. EKO does not control, monitor or shut down your brokerage account. Enable and review your brokerage trade approvals if you rely on them. In-app brokerage activity is separate from Elysium activity.',
      ONCHAIN_ADVISORY,
      'Session-key enforcement, approval tools and kill controls remain staged until their release gates pass. No unavailable control should be relied upon. Review wording is AI-assisted and automated review, not a professional audit; completion of any review still requires separate evidence.',
    ] },
  ] },
  { slug: 'ai', title: 'AI disclosure', sections: [
    { title: 'Analysis and forecasts', paragraphs: [
      'EKO combines structured chain fields and deterministic rules with AI-generated analysis where enabled. Models can invent facts, misread context or produce biased outputs. Beta forecasts describe possible behavior; they do not predict prices or direct trades. Verify source evidence and timestamps independently.',
      'AI output does not grant trading permission or replace mandatory checks. Untrusted token text stays marked as untrusted data rather than instructions. Sanitisation and checks can fail. An unavailable model or source must be disclosed instead of inventing an answer.',
      DYOR,
    ] },
    { title: 'Private data and accountability', paragraphs: [
      'Do not send credentials, private keys or private financial information in token text or public requests. Public analysis is research shared across users, not personalised advice. Published receipts and graded history must distinguish measured results, missing evidence and beta forecasts; a receipt proves a commitment, not that its analysis is correct.',
    ] },
  ] },
  { slug: 'team-trading', title: 'Team trading policy', sections: [
    { title: 'Outputs before trades', paragraphs: [
      'No trading ahead of EKO outputs and no using unpublished research to trade. Publication schedules must not be timed to team trading. Team trading in an asset under pending analysis stays paused until a documented blackout window and exception-review procedure are approved. The duration is pending; this draft does not invent a window.',
      'The team is anonymous. Project wallets must be publicly disclosed before relevant activity. Wallet publication and transaction history are external release evidence, not supplied by these drafts. Any launch token purchases by the team must be disclosed; no claim of zero team holdings is made.',
    ] },
    { title: 'Wallets and records', paragraphs: [
      'The dev wallet pays operating costs from creator fees. Trading exceptions, conflicts and breaches require a dated record without identifying team members.',
    ] },
  ] },
  { slug: 'kol', title: 'KOL disclosure policy', sections: [
    { title: 'Paid posts', paragraphs: [
      '#ad must be the first line of every paid post, including crypto-paid and performance-based arrangements. Disclose the creator’s relevant holdings and compensation relationship clearly; a buried hashtag is insufficient. Include the non-affiliation line whenever Robinhood is named, and the analysis disclaimer whenever analysis is shown.',
      'Use only stage-accurate claims and numbers supported by live product evidence. Do not predict prices or present returns as a reason to use EKO. Performance deals are paid in crypto and do not authorise unsupported product claims. No paid campaign or arrangement is established by this draft.',
    ] },
  ] },
  { slug: 'sanctions', title: 'Sanctions screening policy', sections: [
    { title: 'Screening before execution', paragraphs: [
      'Executable terminal quotes require sanctions screening against the OFAC SDN list before execution can be offered. A screening match, unavailable source or stale screening must prevent executable output; there is no permissive fallback. Do not use EKO to evade sanctions or other applicable restrictions.',
      'Sanctions screening is not accepted in this draft candidate. Source selection, freshness and operating evidence remain external dependencies. Research access or an indicative quote is not confirmation that execution is permitted. This policy does not claim to screen brokerage trades controlled by your own Robinhood connection.',
    ] },
  ] },
];

// Exact allowlist lookup: unknown/path-like/prototype property names never become file paths or HTML.
export function findPolicy(slug: string | undefined) {
  return POLICY_DRAFTS.find((policy) => policy.slug === slug);
}
