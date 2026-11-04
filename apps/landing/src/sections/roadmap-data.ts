// Local draft scope from EKO Overview pp. 7–10, 17–19 and 23–24.
// These are plans, not claims of released capabilities.
export const roadmapDrops = [
  {
    title: "Agent Flow Index", category: "INTELLIGENCE / DATA",
    summary: "See how agent activity shapes a market. Follow the flow, labels and evidence together.",
    intent: "Make agent participation a reading you can inspect.",
    scope: [
      ["Flow & wallet labels", "Agent Flow Index with agent_flow and wallet_label tools, confidence and reasons behind each classification."],
      ["Annotations & lenses", "Add agent context to your research and explore market activity through focused lenses."],
      ["x402 paid API", "Pay-per-call access for agents and builders consuming EKO’s market intelligence."],
    ],
    gate: "Agent labels and the live index depend on the label-precision gate passing before release.",
  },
  {
    title: "Rug Ring Radar", category: "PATTERNS / CONNECTIONS",
    summary: "Connect recurring deployers, wallets and crews. Read the pattern behind the next launch.",
    intent: "Follow connected activity beyond a single token.",
    scope: [
      ["Crew context", "Bring related wallet and deployer activity into a shared view of a suspected crew."],
      ["Recurring patterns", "Connect new activity to playbook and deployer history for a more informed investigation."],
      ["Leaderboards", "Explore crew rankings alongside supporting signals, with classifications treated as inference."],
    ],
    gate: "Recorded demo and green evaluation checks. Wallet relationships remain evidence to inspect, not proof of identity.",
  },
  {
    title: "The Arena", category: "SEASON 01 / PAPER",
    summary: "A proving ground for strategies. Compare decisions in a paper environment before putting capital behind them.",
    intent: "Turn competing ideas into a visible test of skill.",
    scope: [
      ["Season one", "The first planned Arena season brings strategies into a shared paper-trading competition."],
      ["Strategy comparison", "Compare how approaches respond to market conditions without treating simulated results as live returns."],
      ["Open participation", "The planned format uses skill-based prizes, with no purchase needed to take part."],
    ],
    gate: "Season format, recorded demo and evaluation checks must be ready before the competition opens.",
  },
  {
    title: "The Desk", category: "RESEARCH / DEBATE",
    summary: "Researcher. Risk manager. Executor. A team that debates a decision before your agent takes the next step.",
    intent: "Give the signal a second opinion—and a third.",
    scope: [
      ["Multi-agent workflow", "A researcher-to-risk-manager-to-executor workflow, with your own agent responsible for execution."],
      ["Ask the Swarm", "Question the committee and explore the reasoning from multiple model perspectives."],
      ["Exposure awareness", "Net exposure across agents and check orders through preflight, with debates designed to stream live."],
    ],
    gate: "The Desk and Ask the Swarm remain planned. Model reasoning stays distinguishable from observed market evidence.",
  },
  {
    title: "Agent Launcher", category: "OWNERSHIP / CONTROL",
    summary: "Your agent, on your infrastructure. Connect EKO’s tools without handing over the controls.",
    intent: "Make an agent easier to start, while keeping it yours.",
    scope: [
      ["Your environment", "Deploy your own agent to an Akash or VPS environment that you operate."],
      ["Harness connection", "Connect the agent to EKO’s Senses, preflight checks and decision journal."],
      ["Human oversight", "Review policies and reported activity through Mission Control as those capabilities become available."],
    ],
    gate: "Deployment and connection flows must be demonstrated. EKO does not operate the agent or hold your venue credentials.",
  },
  {
    title: "Loop Lab Pro", category: "SIMULATION / RESEARCH",
    summary: "Test beyond a single replay. Explore shadow runs, stress scenarios and different models.",
    intent: "Understand where a strategy bends before it breaks.",
    scope: [
      ["Paper shadow runs", "Planned seven-day shadow runs follow a strategy forward without treating paper positions as live execution."],
      ["Stress & comparison", "Explore adverse scenarios, including crowded exits, and compare model decisions under the same assumptions."],
      ["Stocks lane", "Bring your own stock data through your connection. Individual results remain private to you."],
    ],
    gate: "Stock-data permissions and integration limits must be verified. Historical and simulated results do not predict future performance.",
  },
  {
    title: "EKO Inside", category: "REPUTATION / PARTNERS",
    summary: "Carry EKO’s context into other tools, with reputation, partner integrations and reviewed automation.",
    intent: "Let the evidence travel with the agent.",
    scope: [
      ["EKO Score", "A planned reputation layer aligned with ERC-8004, connecting agent identity to an inspectable record."],
      ["Widget & partner API", "EKO Inside brings EKO readings into partner products through an embedded widget and API."],
    ],
    gate: "The widget and partner API need a recorded demo and green evaluation checks before release.",
  },
  {
    title: "Base Expansion", category: "NETWORK / REACH",
    summary: "Extend EKO’s reach to Base while keeping the evidence behind each reading visible.",
    intent: "A wider network, with the same demand for context.",
    scope: [
      ["Additional chain", "HyperCore order books and perps follow once Elysium’s HyperCore link ships."],
      ["Coverage review", "The release demo will identify which readings and workflows are supported on the new network."],
      ["Clear boundaries", "Release notes will distinguish supported coverage from features that remain in development."],
    ],
    gate: "A recorded Base demo and the relevant evaluation gates must be ready before this expansion is released.",
  },
  {
    title: "A Connected Ecosystem", category: "BUILDERS / INSTITUTIONS",
    summary: "Institutional tooling, a marketplace and agent-to-agent work. The next horizon for EKO’s intelligence.",
    intent: "Build beyond the terminal, with EKO as part of the system.",
    scope: [
      ["Institutional pack", "A planned package for institutional workflows; final capabilities are defined through its release demo."],
      ["Marketplace", "A planned marketplace extends the ecosystem around EKO’s tools and participating agents."],
      ["EKO as an agent", "Explore agent-to-agent jobs using the proposed ERC-8183 standard as part of the final planned drop."],
    ],
    gate: "These later-stage capabilities remain planned. Their demos, scope and evaluation results precede release.",
  },
];
