# SignalOS brand guidelines · v2 "Afterhours Terminal"

## The idea

**Bots call it. You make the call.** SignalOS puts a crew of AI analysts and rules bots on your chart. They publish calls; you make every decision. The product is sold as the *Afterhours Terminal*, and the line under everything is **Trade smarter. On your terms.**

The brand is **loud about the tool and sober about the market.** Four pillars:

1. **Your call.** The human decides. Every trade is a review and a click, and every live trade is a signature.
2. **Honest numbers.** Four labelled prices, a receipt for every call, and no win-rate bragging.
3. **Colours with a job.** Mint is buy and red is sell, always. Mode colours never lie about what money is at stake.
4. **Glossy, not gamified.** Bright, tactile and full of character — but no confetti, streaks, points or token.

## Logo

- **Wordmark: SIGNALOS.** Set in Anton, slanted 12°, uppercase. Outlined in every file, so it never depends on a font.
- **Mark: the loop.** A glossy blue infinity ribbon — calls that never stop, looped through your decision. It sits to the right of the wordmark, overlapping its last letter slightly.
- **Files** (`logo/`, PNG exports in `png/`):

  | File | Use |
  |---|---|
  | `lockup-ink` | The default on the sky header and light surfaces |
  | `lockup-white` | On navy and dark photography-free surfaces |
  | `lockup-on-sky`, `lockup-on-navy` | With their own background, for press |
  | `stacked-*` | Square-ish placements (avatars, stickers, slides) |
  | `symbol` | The glossy mark alone; `symbol-mono-*` for one-colour print |
  | `lockup-mono-ink`, `lockup-mono-white` | One-colour reproduction |
  | `app-icon` (navy), `app-icon-sky`, `favicon` | App icons and browser tab |

- **Clear space:** the height of one loop of the mark on every side.
- **Minimum size:** lockup 96 px wide; symbol 16 px.
- **Don't:** stretch or re-slant the wordmark, recolour the mark in buy/sell colours, add outlines or extra effects to the mark, or place the logo on busy photography.

## Colour

| Name | Hex | Job |
|---|---|---|
| Sky | `#4EB7FA` | The header gradient and brand surface |
| Blue | `#2F95FF` | Primary actions, selection, AI at work, paper mode |
| Navy night | `#05090D` | Product background |
| Card | `#0C1216` | Cards and panels |
| Ink | `#0A1624` | Text and marks on sky |
| **Mint** | `#19D99F` | **Buy and gains. Reserved.** |
| **Red** | `#F0445A` | **Sell and losses. Reserved.** |
| Live | `#FF4FA8` | Real-money mode |
| Testnet | `#A996FF` | Testnet mode |
| Amber | `#FFB547` | Warnings and set-up prompts |

**Rules:**

- **Mint and red are reserved.** Never use them for decoration, bot identities, illustrations or backgrounds.
- **Bot identity hues** stay out of the green (88°–174°) and red (344°–18°) bands. The product enforces this with `safeHue()`, including for community bots.
- **Modes** always carry their name as well as their colour: *Paper Mode*, *Testnet*, *Live · real funds*.
- **Never rely on colour alone.** Buy and sell always carry the word (and ▲/▼ in lists).
- The header gradient runs `#4BB1F8 → #4EB7FA → #74C6FC`. The focused-analyst gradient runs `#2A8FF8 → #52B2FF`.

## Type

All three families are free under the SIL Open Font License.

- **Anton (display).** Slanted 12°, uppercase, tight. The wordmark, page titles and campaign lines only — never body copy.
- **Geist (interface).** Labels, buttons, card prices and everything people read.
- **Geist Mono (numbers).** Tables, order sizes, timestamps — always with tabular figures and a slashed zero.

## Shape and depth

- **Cards:** 12 px radius, hairline borders, one step lighter than the page.
- **Gloss is for the brand's objects:** the mark, the decorative ribbon and the crew's jelly avatars. Buttons get a soft top highlight and a coloured glow; surfaces stay flat.
- **Crew avatars:** each bot's glyph rendered as a lit tube in its hue — rim, specular highlight, soft glow. No tiles, no faces.
- **Calls on the chart:** actionable calls are outlined pills with the amount (`BUY $100 / Atlas • now`); past calls keep a small label (`SELL / Pulse • 12:55`). Both sit on a short stem above a lit dot at the exact price.

## Motion

- A call ripples in at its price, the dot drops on a spring and the pill rises on its stem; one sheen crosses it.
- "Ask now" shows a live wait counter — AI reads take seconds, and the UI says so.
- Every motion respects `prefers-reduced-motion`, and the app has its own motion setting.
- No celebratory motion on trades: a fill is confirmed, not celebrated.

## Voice

**Hype the tool. Never the returns.** Confident, plain, a little playful, and always able to show a receipt.

**Say:**
- "Bots call it. You make the call."
- "Trade smarter. On your terms."
- "Paper trading is on by default."
- "Nothing trades until your wallet signs."
- "Don't trust a bot. Test it."
- "One key powers every analyst."

**Never say:**
- "beats the market," "predicts," "guaranteed," "risk-free," "passive income"
- "instant fills," "zero slippage"
- unverifiable numbers
- anything that implies a Robinhood brokerage link or any endorsement

The full list of claims, with the evidence behind each, is in `copy/COPY_DECK.md` §10.

## Required disclaimers

- Any post about trading needs **"Not investment advice."**
- Price visuals need **"Illustration. Example values."** (or "simulated demo data" for product screenshots).
- Paper visuals need **"Paper trading uses simulated funds."**
- Backtests need **"Hypothetical. Past or backtested results don't predict future results."**
- Robinhood Chain mentions need: **SignalOS is an independent app on Robinhood Chain, not a Robinhood brokerage product.**

## References (inspiration, not imitation)

- Pro trading terminals: dense, card-based layouts where the chart and the ticket share one screen.
- Glossy 3D "jelly" iconography: tactile objects that give software a character.
- Condensed, slanted sports lettering for a wordmark that reads at 20 px and at billboard size.

**We deliberately avoid:**
- Robinhood's trade dress: feathers, "Robin Neon" chartreuse, black-and-neon layouts, serif headlines.
- Crypto clichés: bulls, rockets, moons, glowing robots, hexagon "blockchain" graphics.
