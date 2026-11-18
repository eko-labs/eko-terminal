import { CHAIN_NAME, pick } from "../chain";

export type DocLink = { label: string; href: string };
export type Section = { id: string; title: string; paragraphs: string[]; links?: DocLink[] };
export type Guide = { id: string; label: string; intro: string; sections: Section[] };

const launchpad = pick({ elysium: "Montra", robinhood: "Pons" });
const coverage = pick({
  elysium: "The terminal follows supported Elysium launches and their Uniswap v4 pools.",
  robinhood: "The terminal follows native-ETH Pons launches on Robinhood Chain, first on their bonding curves and then in their Pons-linked Uniswap v4 pools. It skips Pons launches quoted in USDG or other tokens.",
});
const routes = pick({
  elysium: "Supported trades use Uniswap v4 and native HYPE.",
  robinhood: "Supported trades use native ETH. EKO routes to the coin’s Pons curve before graduation and to Uniswap v4 after graduation. It declines curve buys that would complete the curve and waits for the pool when the curve closes.",
});
const launchSnipers = pick({ elysium: "10", robinhood: "35" });

export const guides: Guide[] = [
  {
    id: "overview",
    label: "Getting started",
    intro: `EKO is a research and trading terminal for ${CHAIN_NAME}. Read the evidence behind a coin’s verdict and use your own wallet if you choose to trade.`,
    sections: [
      { id: "coverage", title: "Which coins EKO follows", paragraphs: [coverage] },
      { id: "find", title: "Find a coin", paragraphs: [
        "Use the token’s contract address to distinguish it from coins with similar names. Radar and Pairs list tracked coins. Open a coin to see the verdict, evidence and an available trading route. Reading these pages requires no wallet.",
      ], links: [{ label: "Open Radar", href: "/radar" }, { label: "Browse Pairs", href: "/pairs" }] },
    ],
  },
  {
    id: "senses",
    label: "Checks and verdicts",
    intro: "EKO combines rule-based checks on chain data with a simulated buy and sell. Conditions can change between a check and a trade.",
    sections: [
      { id: "verdicts", title: "Read the verdict", paragraphs: [
        "No flags (clear) means the checks found no Monitor or Danger match. Informational findings can still appear. Monitor flags a reason to look closer. Danger means at least one higher-severity rule matched. Pending means the check is incomplete, for example when the simulation is unavailable or the launch fee window is still active. A Danger finding takes precedence over Pending.",
      ] },
      { id: "exit-cost", title: "Exit cost and fees", paragraphs: [
        "EKO simulates buying a coin and selling the resulting tokens on the same route at a recent block. Exit cost is the share of the input lost on that round trip, before network gas. EKO targets about $1,000 when it has a native-asset price. Check availability before interpreting the number.",
      ] },
      { id: "supply", title: "Supply and wallet activity", paragraphs: [
        `EKO uses transfers and trade events to estimate holder balances and identify wallets that bought within ${launchSnipers} blocks of launch. A launch-sniper label describes timing. Wallet activity does not establish a person’s identity or whether a bot made the trade. The agent, crew and human flow split is unavailable.`,
      ] },
      ...(pick({ elysium: [], robinhood: [
        { id: "curve", title: "Curve progress and run-up", paragraphs: [
          "Pons graduation progress compares the curve’s real ETH reserve, after fees and taxes, with its graduation threshold. The run-up check looks at how much supply has been bought off the curve, including net buying over the last hour. The separate run-up score shows the size of a hypothetical fall back to the starting curve price.",
        ] },
      ] })),
    ],
  },
  {
    id: "guardrails",
    label: "Trading",
    intro: routes,
    sections: [
      { id: "quote", title: "Review the quote", paragraphs: [
        `The trade panel shows the current per-trade cap, estimated output, minimum output, estimated network fee and warnings. Quotes expire after 30 seconds. EKO currently charges no terminal fee. Network gas and ${launchpad} fees still apply.`,
        "A Danger honeypot finding blocks buys through EKO and warns on sells. Other Danger findings, incomplete checks, an active launch fee and large price impact can require acknowledgement. If the exact swap simulation fails, EKO declines to prepare the transaction.",
      ] },
      { id: "sign", title: "Sign with your own wallet", paragraphs: [
        `Sign in with your wallet on ${CHAIN_NAME}. Review and sign any token approvals required for a sell, then review the swap in your wallet. EKO prepares unsigned transactions and your wallet signs and submits them. A failed on-chain transaction can still cost gas.`,
      ], links: [{ label: "Terms of service", href: "/legal/terms" }, { label: "Risk disclosure", href: "/legal/risk" }] },
    ],
  },
  {
    id: "connect",
    label: "Connected agents",
    intro: "Mission Control can connect an external agent to EKO through its Model Context Protocol (MCP) endpoint.",
    sections: [
      { id: "agent", title: "Connect and review an agent", paragraphs: [
        "Sign in, register an agent in Mission Control and use the connection instructions there. An agent with an access key can ask for a preflight and see whether EKO allows it, denies it or requires your approval. When trading is enabled, the agent can request an unsigned transaction after an allowed preflight for the wallet you configured.",
        "Preflight is advisory for actions outside EKO. Pausing an agent in Mission Control makes its preflight deny and blocks trade preparation for that agent. The agent and its wallet remain under your control.",
      ], links: [{ label: "Open Mission Control", href: "/mission" }] },
    ],
  },
  {
    id: "privacy",
    label: "Privacy and data",
    intro: "EKO holds no user funds or wallet keys. Wallet addresses and on-chain transactions are public.",
    sections: [
      { id: "account", title: "What EKO keeps", paragraphs: [
        "Signing in links your public wallet address to an account. EKO stores session hashes, saved preferences, watchlists, alert settings and order history. Connecting an agent adds its settings, access-key hashes, journal and approvals.",
        "In Settings under Privacy & data, Delete my data removes your EKO account records. Public chain transactions remain on-chain.",
      ], links: [{ label: "Privacy policy", href: "/legal/privacy" }] },
    ],
  },
];
