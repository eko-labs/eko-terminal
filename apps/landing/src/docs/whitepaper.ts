import { CHAIN_NAME, pick } from "../chain";
import type { Section } from "./content";

export const whitepaperIntro = pick({
  elysium: "How EKO observes supported launches, evaluates buyer risk and prepares trades on Elysium.",
  robinhood: "How EKO observes native-ETH Pons launches, evaluates buyer risk and prepares trades on Robinhood Chain.",
});

export const whitepaper: Section[] = [
  {
    id: "scope",
    title: "Scope and problem",
    paragraphs: [
      "New coins can trade before buyers have much evidence about who holds the supply, what a sale would return or how fast conditions can change. Concentrated buyers can sell into later demand. Thin liquidity, taxes and price impact can make an exit costly. A route that works at one block can fail later.",
      `EKO is a research and trading terminal built on ${CHAIN_NAME}. It collects public chain data, applies deterministic rules and simulates trades. The verdict and evidence are available without signing in. Trading and agent management use a wallet-based account.`,
    ],
  },
  ...pick({
    elysium: [
      {
        id: "chain",
        title: "Chain ingestion",
        paragraphs: [
          "EKO follows Montra and other supported launches on Elysium. It processes launch logs, Uniswap v4 swaps and token transfers for coins it tracks. Its live view covers recent activity.",
          "EKO uses the chain’s JSON-RPC for logs and contract state, and Hyperliquid’s market-data API to estimate HYPE in US dollars.",
        ],
      },
    ],
    robinhood: [
      {
        id: "chain",
        title: "Chain ingestion",
        paragraphs: [
          "EKO reads Robinhood Chain (chain ID 4663) through JSON-RPC. The Pons factory’s TokenLaunched event identifies the coin, deployer, curve and graduation threshold. EKO follows curves quoted in native ETH. It skips USDG and other token-quoted launches.",
          "Before graduation, CurveBuy and CurveSell events provide trade amounts, fees and taxes. Buys add ETH to the real quote reserve after fees and taxes. Sells remove the ETH payout plus fees and taxes. EKO divides the real reserve by the launch’s graduation threshold to calculate curve progress. The native-ETH launches measured in the chain notes used a 4.2 ETH threshold.",
          "EKO recognizes graduation by a Uniswap v4 Initialize event for the native ETH/coin pool with the configured Pons hook. It checks the pool ID against the pool key and follows Swap events for that pool. ERC-20 Transfer events inform holder balances before and after graduation.",
        ],
      },
    ],
  }),
  {
    id: "exit",
    title: "Sell simulation and exit cost",
    paragraphs: [
      "A read-only eth_call at a recent block uses a temporary funded simulation contract. It buys on the tracked route, then tries to sell the tokens it received. Exit cost is the percentage of input lost after the two legs, before network gas. It reflects the fees and price impact realized by that simulation. It can differ at another size, on another route or at a later block.",
      pick({
        elysium: "The reference size targets about $1,000 when a native-asset price is available.",
        robinhood: "The reference size targets about $1,000 using the ETH/USD estimate. If no price is available, the Robinhood probe uses 0.25 ETH. It checks the Pons curve while open and the Pons-linked v4 pool after graduation.",
      }),
      "The honeypot rule can flag Danger when the simulated buy succeeds but the sale reverts or returns less than 5% of input. An unavailable simulation supplies no sell result. During the launch fee window, EKO suppresses the honeypot rule and schedules another check after the window ends.",
      pick({
        elysium: "The reference simulation sends no transaction and uses no funds from your wallet.",
        robinhood: "EKO reads the Pons curve’s standard fee and creator tax. The separate launch tax for measured Pons launches steps down from 99% to 6.18% to 0.19%, then reaches zero after three seconds. A simulation that closes the curve by buying its last sellable tokens leaves the exit check unavailable. On the graduated pool, the Pons hook’s charge is included when the v4 quoter prices the swap.",
      }),
    ],
  },
  {
    id: "activity",
    title: "Holders, early buyers and deployer activity",
    paragraphs: [
      "EKO reconstructs balances from tracked transfers. It looks at each wallet’s net token movement in a tracked trade transaction to infer who bought or sold. It excludes infrastructure such as the pool manager and known burn addresses from holder counts. The concentration rule flags Monitor when the top ten holders have at least 20% of supply, the largest non-deployer holder has at least 10%, or top holders with no observed buys other than the deployer have at least 5% combined. If the top ten hold at least 50%, the rule flags Danger.",
      pick({
        elysium: "The launch-sniper check identifies net buyers other than the deployer within 10 blocks of launch. It compares the supply they bought with what they still hold. When available, priority fees accompany the evidence.",
        robinhood: "The launch-sniper check identifies net buyers other than the deployer within 35 blocks of launch, about 3.5 seconds at the measured block rate. It compares the supply they bought with what they still hold. Priority fees, when available, accompany the evidence. The label describes on-chain timing and holdings. It does not establish that a wallet used a bot.",
      }),
      "A separate check measures supply bought in the first minute and how much those wallets still hold, including the deployer. The deployer check looks at its remaining share and early selling activity, using observed amounts sold, cash in and out and time to first sale. Recorded deployer history can inform repeat-launch findings when available. Wallets can share an owner, and an owner can trade through multiple addresses.",
      "The flow view can show observed trading activity. EKO does not publish an agent, crew or human split for that activity. First-minute holdings alone do not establish that wallets share a funder.",
    ],
  },
  ...pick({
    elysium: [],
    robinhood: [
      {
        id: "curve-risk",
        title: "Curve run-up and graduation liquidity",
        paragraphs: [
          "The run-up rule measures the share of total supply bought off the Pons curve, net of sells. It flags Monitor once net buying reaches 30% of supply and Danger if net buying in the last hour reaches 30%. The separate run-up score in the terminal estimates the percentage decline if the price returned to its starting curve price, using current curve progress. It describes a hypothetical move.",
          "After graduation EKO checks whether the configured Pons locker owns the expected liquidity position for that pool, with positive liquidity and no token approval. It checks the locker and PositionManager code against pinned hashes. Missing or failed proof leaves the lock unconfirmed. This check covers the graduation position. EKO does not measure total market depth or comprehensively analyze token owner powers.",
        ],
      },
    ],
  }),
  {
    id: "verdicts",
    title: "Verdicts and evidence",
    paragraphs: [
      "No flags (clear) means the rules found no Monitor or Danger match. Informational observations can still be present. Monitor indicates a risk signal that warrants a closer look. Danger means a higher-severity rule matched. The strongest Monitor or Danger finding determines the verdict.",
      "Pending means EKO is still checking the coin or could not complete the required simulation, or that the launch fee window is active. A Danger match can still be shown. Read the reasons, supporting transactions or addresses and any fields marked unavailable. A verdict describes the evidence EKO had at the time and can change as new data arrives.",
      "Token names and symbols are untrusted input. The agent-bait rule looks for instructions embedded in those fields, and EKO marks coin identity text as untrusted for downstream clients. The rules and simulations run without an AI model.",
    ],
  },
  {
    id: "trading",
    title: "Trade preparation and limits",
    paragraphs: [
      pick({
        elysium: "The terminal prepares supported swaps against Uniswap v4 contracts. It charges no terminal fee. Network gas and venue fees still apply.",
        robinhood: "The terminal prepares supported swaps against a Pons curve or the Pons-linked Uniswap v4 pool after graduation. It refuses curve buys that would complete the curve and does not trade a closed curve while waiting for the pool. EKO charges no terminal fee. Network gas, venue fees and token-specific taxes still apply.",
      }),
      "The deployment sets the per-trade cap shown in the panel. The launch configuration caps trades at $250 or less. The edge accepts slippage settings from 0.1% to 50%. A quote expires after 30 seconds and specifies the minimum output the swap must return.",
      "A Danger honeypot finding prevents EKO from preparing a buy and warns on a sell. Other Danger findings, a pending verdict, an active launch fee and price impact of 10% or more can require acknowledgement in the trade panel. Before creating a new order, EKO simulates the exact swap from the wallet. It declines to prepare the order if that simulation fails.",
      pick({
        elysium: "A sell can require an exact-amount token approval and a time-limited Permit2 allowance. The wallet signs and sends any required approvals and the swap.",
        robinhood: "A curve sell can require allowance for the curve. A v4 sell can require token approval for Permit2 and a time-limited Permit2 allowance for the router. EKO requests approvals for the exact amount needed when existing allowances are insufficient. Your wallet signs and submits every approval and swap, and proceeds go to the wallet.",
      }),
      "EKO tracks submitted orders using transaction receipts. Conditions can change before a swap lands. A reverted transaction can still cost gas. Trading through EKO can pause, and other wallets or interfaces can send their own trades independently.",
    ],
    links: [{ label: "Terms of service", href: "/legal/terms" }, { label: "Risk disclosure", href: "/legal/risk" }],
  },
  {
    id: "freshness",
    title: "Data sources and freshness",
    paragraphs: [
      "The edge polls for new blocks and processes logs, with a default polling interval of two seconds. It runs contract reads and the reference sell probe against recent state. A coin-page request can trigger a recheck when the cached probe is stale. The verdict can incorporate newer holder or trade data alongside a cached simulation. Readings can lag after launch or an RPC interruption.",
      pick({
        elysium: "The live view follows a bounded recent window. Provider downtime, rate limits and incomplete history can leave readings unavailable.",
        robinhood: "The live tracker keeps a rolling window and uses recent launch and graduation logs to rebuild its view. Public RPC access to historical state is limited. EKO may have incomplete history for an older launch. Blockscout links let you inspect evidence in an explorer. The launch checks use RPC reads.",
      }),
      pick({
        elysium: "USD estimates use the latest available HYPE price from Hyperliquid’s public market-data API.",
        robinhood: "USD estimates use the ETH midpoint from Hyperliquid’s public market-data API, cross-checked against a Uniswap v3 WETH/USDG pool on Robinhood Chain. EKO retains the last accepted price if a source fails or the readings disagree beyond the configured threshold.",
      }),
    ],
  },
  {
    id: "privacy",
    title: "Privacy and security",
    paragraphs: [
      "EKO holds no user funds, private keys or seed phrases. Sign-In with Ethereum links a public address to an account using a signed message for this site and chain. The browser receives an HttpOnly session cookie. The server stores a hash of its token.",
      "The account database stores watchlists, preferences, alert settings and order details including trade amounts, status and submitted transaction hashes. If you connect an agent, EKO keeps its settings, access-key hashes, journal and approvals. EKO also stores observed public launch data for its chain history.",
      "EKO uses request IP addresses in memory for rate limiting. Its hosting provider may keep separate request logs. Delete my data in Settings erases the records attached to your account. Public transactions and public launch data remain available independently of your account.",
    ],
    links: [{ label: "Privacy policy", href: "/legal/privacy" }],
  },
  {
    id: "limits",
    title: "Limits of the system",
    paragraphs: [
      "The verdict describes a tracked route at the time of observation. EKO does not cover all launches, identify beneficial owners, predict prices or provide investment advice. You can lose the full amount of a trade.",
      pick({
        elysium: "EKO prepares on-chain swaps on supported routes. It does not execute stock or perpetual futures orders.",
        robinhood: "EKO prepares swaps on supported Robinhood Chain routes. It does not ask for your Robinhood brokerage login, monitor your brokerage account or place brokerage orders.",
      }),
      "External-agent preflight is advisory. When an agent uses EKO to prepare an unsigned swap, EKO checks its preflight decision for that trade. Mission Control can pause trade preparation for an agent. The agent can still operate through other interfaces.",
    ],
  },
  {
    id: "roadmap",
    title: "Roadmap plans",
    paragraphs: [
      "The roadmap proposes wallet classification and an Agent Flow Index once labels meet their evaluation criteria, expanded research and strategy replay tools, and additional network support. These are plans. Scope and availability depend on testing and release decisions.",
    ],
    links: [{ label: "View the roadmap", href: "/#roadmap" }],
  },
];
