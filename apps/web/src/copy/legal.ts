import { ADVISORY, DYOR, NON_AFFILIATION } from './index';

export interface PolicyDraft {
  slug: string;
  title: string;
  sections: readonly { title: string; paragraphs: readonly string[] }[];
}

// Approval is an external owner decision tied to an exact version, never inferred from a build.
// The owner approved the Elysium Terms and Privacy on 2026-11-16, recorded in docs/public-launch/OWNER-DECISIONS.md
// (item 9; the 2026-10-05 versions described the Robinhood Chain build).
export const POLICY_APPROVAL = {
  slugs: ['terms', 'privacy'],
  version: '2026-11-16',
  approvedAt: '2026-11-16',
  evidenceRef: 'docs/public-launch/OWNER-DECISIONS.md',
} as const;
export const isApprovedPolicy = (slug: string) => (POLICY_APPROVAL.slugs as readonly string[]).includes(slug);

// The other policies stay drafts until the owner approves them.
export const POLICY_REVIEW = {
  version: '2026-11-16-draft.4',
  draftedAt: '2026-11-16',
  effectiveAt: null,
  ownerApproval: { dueAt: null, approvedAt: null, evidenceRef: null },
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

// TODO(spec): Set the team blackout duration and exception-review procedure externally; no window is invented here.
export const POLICY_DRAFTS: readonly PolicyDraft[] = [
  { slug: 'terms', title: 'Terms of service', sections: [
    { title: 'What EKO is', paragraphs: [
      'EKO is a research terminal for coins launched on Montra, on the Elysium blockchain. It follows new launches and their pools, runs automated safety checks on each coin, lets you trade from your own wallet, and lets you connect your own trading agent so it can check a coin with EKO before it trades.',
      'EKO’s checks are automated rules and simulations, the same for every user. They are not investment advice and not a recommendation to buy or sell anything. You make your own decisions and you carry the risk of any loss.',
    ] },
    { title: 'Your wallet, your keys', paragraphs: [
      'EKO is non-custodial. Your wallet signs every trade and every token approval, and approvals are for the exact amount of the trade. EKO’s servers never hold your private keys, your seed phrase or your funds, and EKO cannot move anything from your wallet.',
      'Before you sign, check the coin, amount, network and fees your wallet shows you. Network gas, Montra’s trading fees (including the higher fee in a coin’s first moments), slippage and failed transactions can all cost money.',
    ] },
    { title: 'Trading through EKO', paragraphs: [
      'Trades go through Uniswap’s public contracts on Elysium. Before EKO prepares a trade it gets a quote from the pool and simulates the exact transaction from your wallet; if the simulation fails, the trade is not offered.',
      'If EKO’s check could not sell a coin back, EKO refuses to prepare a buy of it. If EKO rates a coin Danger, has not finished checking it, or the trade would move the price a lot, you are asked to acknowledge the warning first. A coin that passed its checks can still become unsellable later.',
      'Each trade has a size limit, shown in the app. Trading through EKO can be paused at any time, for example during an outage or while a required check is unavailable.',
    ] },
    { title: 'Fees', paragraphs: [
      'EKO charges no fee on trades right now. Network gas and Montra’s own fees still apply.',
      'If EKO starts charging a fee, it will be announced on this page before it starts, and it will be shown in every quote before you sign.',
    ] },
    { title: 'Connected agents', paragraphs: [
      'You can give your own AI agent an access key so it can check coins with EKO and ask EKO to prepare trades. These checks are advisory: an agent can ignore them, and EKO cannot stop a wallet it does not control. Pausing or stopping an agent in EKO only stops EKO from serving that agent.',
      'You are responsible for what your agent does and for keeping its access key secret. Revoke a key in EKO if you think it has leaked.',
    ] },
    { title: 'Fair use', paragraphs: [
      'Do not use EKO for anything unlawful, to evade sanctions, to attack or overload the service, or to interfere with other users. EKO limits how often anyone can use it, to keep it working for everyone.',
      'Coin names, descriptions and links are written by strangers. EKO shows them as untrusted text; treat them that way too.',
    ] },
    { title: 'What can go wrong', paragraphs: [
      'Chain data can be missing, late or wrong. Safety checks can miss harmful behavior, and a verdict can change as a coin’s pool changes. The service can slow down, pause or go offline. Check the live status before you act.',
      'EKO is provided as it is. To the extent the law allows, EKO is not liable for losses from trades, from coins, from third-party contracts or networks, or from the service being unavailable.',
    ] },
    { title: 'Who runs what', paragraphs: [
      'EKO is independent. The Elysium network, the Montra launchpad, the Uniswap contracts and the HYPE price feed are run by others, and EKO does not control them.',
    ] },
    { title: 'Changes', paragraphs: [
      'If these terms change, the new version will be posted on this page with a new version number and date.',
    ] },
  ] },
  { slug: 'privacy', title: 'Privacy policy', sections: [
    { title: 'The short version', paragraphs: [
      'EKO collects as little as it can. It never receives your private keys or your seed phrase. You can use most of EKO without signing in. Wallet addresses and blockchain transactions are public by nature.',
    ] },
    { title: 'What EKO stores when you sign in', paragraphs: [
      'Your account: signing in with your wallet (Sign-In with Ethereum) links your public wallet address to an account. A wallet address is a public identifier, not an anonymous one.',
      'Your session: a sign-in cookie, used only to keep you signed in. EKO stores a hash of it, not the cookie itself. Sessions last 30 days.',
      'Things you save: your watchlist, alert settings and preferences.',
      'Your trades: for each trade you make through EKO, the coin, the side, the amounts and the transaction hash, so you can see your order history. EKO keeps your 500 most recent.',
      'Connected agents: if you connect a trading agent, its name, settings and wallet address, its access keys (stored as hashes; the full key is shown to you once), the approvals you give it, and its journal: the checks, decisions and orders EKO and your agent record.',
    ] },
    { title: 'What EKO does not collect', paragraphs: [
      'EKO does not run analytics, advertising or tracking cookies, and does not sell or share your data.',
      'EKO’s servers use your IP address in memory to limit abuse and keep the service running. EKO does not save it.',
    ] },
    { title: 'Who else handles data', paragraphs: [
      'Hosting: Railway runs EKO’s servers and stores its database. Railway may keep its own request logs, including IP addresses, under its own policies.',
      'Blockchain data: EKO reads Elysium through Kinetiq’s public RPC and explorer. When your wallet reads the chain through EKO, the request goes from EKO’s server, not from your device.',
      'HYPE price: EKO reads the HYPE price from Hyperliquid’s public API. No user data is sent.',
      'Anything you sign is sent to the Elysium network by your own wallet, under your wallet’s own policies.',
    ] },
    { title: 'Deleting your data', paragraphs: [
      'In Settings, under Privacy & data, “Delete my data” erases your account: sessions, watchlist, alert settings, preferences, order history, connected agents, their keys, journals and approvals. It cannot be undone.',
      'Your trades themselves are public transactions on Elysium and cannot be removed by anyone.',
    ] },
    { title: 'How long EKO keeps data', paragraphs: [
      'Sessions end after 30 days. An agent’s journal keeps its newest 1,000 entries and nothing older than 90 days. Everything else stays until you delete it, within these limits: your 500 most recent settled orders, 200 settled approvals per agent, and 10 stopped agents; older entries are removed as new ones arrive.',
    ] },
    { title: 'Changes and contact', paragraphs: [
      'If this policy changes, the new version will be posted on this page with a new version number and date. For privacy questions, contact the official EKO X or Telegram account listed on the Official project links page (/official).',
    ] },
  ] },
  { slug: 'risk', title: 'Risk disclosure', sections: [
    { title: 'You can lose the whole trade', paragraphs: [
      'Montra coins are new and thinly traded. Liquidity can disappear, the price can move sharply in seconds, and a coin that could be sold can become unsellable. Montra charges a higher fee in a coin’s first moments, and transactions can fail and still cost gas. You can lose the entire amount of a trade.',
    ] },
    { title: 'What EKO’s checks can and cannot tell you', paragraphs: [
      'EKO’s checks are automated: a buy-then-sell simulation and rules about the coin’s contract and pool. They describe conditions when they ran and can miss harmful behavior. Verdicts are live status and change as a coin’s pool changes. No flags is not a recommendation, and missing or stale data stays unknown; it is never counted as a pass.',
      DYOR,
    ] },
    { title: 'Agents', paragraphs: [
      ADVISORY,
      'An agent can act on bad information or make mistakes. Stopping an agent in EKO stops EKO from serving it; it does not stop the agent or its wallet.',
    ] },
    { title: 'The service', paragraphs: [
      'Chain data can be late or missing, and EKO can slow down, pause trading or go offline. Check the live status before you act.',
    ] },
  ] },
  { slug: 'ai', title: 'AI disclosure', sections: [
    { title: 'EKO’s verdicts do not use AI', paragraphs: [
      'EKO’s checks and verdicts are rules and simulations, run the same way for every coin and every user. No AI model writes or changes them.',
    ] },
    { title: 'AI agents you connect', paragraphs: [
      'You can connect your own AI agent to EKO. EKO sees only what your agent sends it; your agent’s model, prompts and decisions are yours and run outside EKO. AI agents can invent facts, misread a result or act on a mistake. Review what your agent is allowed to do.',
      'Coin names, descriptions and links are written by strangers. EKO passes them to agents marked as untrusted data, not instructions, but an agent can still be misled by them.',
      'Never give an agent, or send EKO, your private keys or seed phrase.',
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
      '#ad must be the first line of every paid post, including crypto-paid and performance-based arrangements. Disclose the creator’s relevant holdings and compensation relationship clearly; a buried hashtag is insufficient. Include the non-affiliation line whenever Kinetiq or Hyperliquid is named, and the DYOR line whenever EKO’s checks or verdicts are shown.',
      'Use only stage-accurate claims and numbers supported by live product evidence. Do not predict prices or present returns as a reason to use EKO. Performance deals are paid in crypto and do not authorise unsupported product claims. No paid campaign or arrangement is established by this draft.',
    ] },
  ] },
  { slug: 'sanctions', title: 'Sanctions screening policy', sections: [
    { title: 'Where EKO stands today', paragraphs: [
      'EKO does not currently screen wallets against sanctions lists before it prepares a trade. Do not use EKO if you are a sanctioned person, or to deal with one, or to evade sanctions or other restrictions that apply to you.',
      'If EKO adds screening, this page will describe how it works before it starts, including what happens when the screening source is unavailable.',
    ] },
  ] },
];

// Exact allowlist lookup: unknown/path-like/prototype property names never become file paths or HTML.
export function findPolicy(slug: string | undefined) {
  return POLICY_DRAFTS.find((policy) => policy.slug === slug);
}
