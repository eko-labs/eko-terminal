// BACKEND §8.2. Versioned code data keeps the funnel free of file/network I/O.
export const PERSONA_SET_V1 = Object.freeze({
  version: 1,
  models: Object.freeze({ luna: 0.70, sol: 0.20, opus: 0.10 }),
  personas: Object.freeze([
    persona('sniper', 'first 60 s, liquidity, tax', 50, 20, 10),
    persona('momentum', '5 m and 1 h change, volume', 30, 15, 60),
    persona('mcp_retail', 'Claude/GPT agent with a generic trading prompt', 25, 15, 240),
    persona('virtuals', 'agent-token narrative, socials', 40, 25, 120),
    persona('kol_follower', 'trending rank, social presence', 60, 30, 90),
    persona('cautious', 'holders, top-10 share, age', 20, 10, 720),
    persona('whale', 'depth and liquidity', 15, 10, 1440),
    persona('degen', 'everything, ignores risk', 100, 50, 30),
    persona('farmer', 'curve progress, graduation distance', 35, 20, 45),
    persona('copy_trader', 'whether early buyers are in profit', 30, 20, 120),
  ]),
});

function persona(id: string, weighs: string, tp_pct: number, sl_pct: number, max_hold_min: number) {
  return Object.freeze({ id, weighs, exit: Object.freeze({ tp_pct, sl_pct, max_hold_min }) });
}
