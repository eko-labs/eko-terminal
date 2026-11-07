# Design

![Trade screen with a live signal](screenshots/desktop-trade-signal.png)

## Principle: one glance

SignalOS in one sentence: AI analysts (and rules bots) watch the market and call BUY or SELL; **you** decide and trade — with paper money by default, or live on Robinhood Chain mainnet from your own wallet (ETH ⇄ USDG on Uniswap v3).

At any moment the Trade screen answers three questions at a glance:

1. **What market am I on?** — the highlighted row on the left and the pair above the chart.
2. **What is my analyst saying right now?** — the big BUY / SELL (or *Holding off*, *No signal right now*) at the top of the Trade column, and the one tagged call on the chart.
3. **What happens if I tap Buy or Sell?** — the buttons say it: **Buy $100**, **Sell $100**, **Sell all · $42**. One tap trades that amount now.

One analyst at a time. No overlapping sources of truth. Nothing on screen that doesn't help that decision — generous spacing, few borders, few labels, few numbers. One term per concept (a **signal**, which an analyst *calls*; **Paper** and **Live**), and nothing fake.

| Area | What it holds |
|---|---|
| **Header** (sky) | Wordmark and mark · **Trade · Bots · Portfolio** · the **Paper / Live** switch · round **?** (help) · the wallet (connect, verify, network, Settings). |
| **Left: Markets** | One compact row per market: glyph, symbol, a small 24h sparkline, price, 24h change. The selected row is highlighted. A small **On-chain** chip marks the markets that can trade live (the word *Live* is kept for the trading mode). |
| **Centre: chart** | A slim title — pair (click it, or press `/`, to search markets), live price, 24h change — and the toolbar: timeframes, Indicators, full screen. The chart shows **only your analyst's** signals: its live call as a tag whose pill is the trade (`BUY $100`), older calls as small faint dots with details on hover, and one reference line for the live call. *Simulated data* appears only when the data really is simulated. |
| **Under the chart** | **Positions** (asset, amount, average price, value, P&L, **Close**) for the current mode — or one slim line, *No positions yet — your trades show up here*. **Activity** is the second tab: orders and fills, one line each. |
| **Right: Trade column** | Top to bottom and nothing else: the analyst, what it's saying, the amount presets, **Buy** and **Sell**, one result line, one line of fine print (below). |
| **Footer** | Connection dot (click for stream, data, execution, AI and chain status), Help, theme. |

## The Trade column

![After a paper buy](screenshots/desktop-trade-position.png)

1. **Analyst** — avatar, name ▾ (switch between the analysts you've added, or *Browse analysts*), where its answers come from (*Rules*, *Claude · via PPQ*), and its state: *Reading…*, *New · 2m ago* or *No signal*. Picking an analyst makes it **the** analyst: only its signals are on the chart.
2. **Signal** — a big **BUY** or **SELL** with its time left and a one- or two-line reason; **Why?** opens the whole receipt in place (reasoning, invalidation — also drawn on the chart while open — reference price, conviction, source, event history). With no live call it says so plainly — *Holding off* with the analyst's one-line reason when it abstained, or *No signal right now* — and the primary action becomes **Ask Atlas** (with a seconds counter; AI reads take roughly 5–25 s). With a live call, a small labelled **Ask again** stays available. When the analyst, market or timeframe changes and there's no live call, SignalOS asks once for you.
3. **Amount** — preset chips from Settings → *Trade amounts* ($50 · $100 · $250 · $500 by default). The choice is remembered. There is no free-form amount, slippage or estimate table.
4. **Buy / Sell** — two big buttons, mint and red. **One tap trades now**: paper fills in one server call; live goes straight to your wallet (network switch and sign-in if needed, an exact approval if needed, then the swap). The side your analyst is calling glows softly, but both always work. Sell is disabled with *You don't hold ETH* when there's nothing to sell, and reads **Sell all · $42** when you hold less than the preset. While a trade runs, the button shows what's happening — *Filling…*, *Confirm in your wallet…*, *Approving USDG…* — and a second tap does nothing. The result is one line under the buttons (*Bought 0.0376 ETH at $2,656.12*, *Submitted — waiting for confirmation*, or the reason it didn't happen) plus a toast. A live trade above your *Ask before large Live trades* limit waits for an explicit **Confirm**. *Paper balance* sits just above the presets.
5. **Fine print** — *Paper money · Not investment advice*, or on Live: *Live · Robinhood Chain · your wallet signs every trade*.

The pill on the chart (`BUY $100`) is the same button: same amount, same engine, same guards. When the market data is stale, when Live is off on the server or the market has no live route, both buttons are disabled and the result line says why. **Close** on a position sells all of it the same way — no extra dialog on Paper; on Live the wallet prompt is the confirmation.

**Live** is never one click away by accident: the Paper/Live switch opens the Live setup guide, which checks the wallet, network and server and asks for an explicit acknowledgement. Going back to Paper is one click. A submitted transaction shows as *waiting for confirmation* until the chain confirms it — never as filled.

## Phones (< 900 px)

![Phone](screenshots/mobile-trade-signal.png)

Header (logo, Paper/Live, wallet, a menu with the pages and Help), then three small tabs — **Chart · Markets · Positions** — for the top area, and the Trade column docked below as a sheet: analyst, signal, presets, Buy / Sell. Buy and Sell are always on screen without scrolling; the analyst's reasoning scrolls inside the sheet. No horizontal page scroll at 390 px.

## Other pages

- **Bots** — *Analysts*: one card each with avatar, name, what kind it is (*AI analyst · GPT via PPQ*, *Rules*, *Ensemble*), one line of what it does, and **Add analyst / Added**. Filter by kind. *Backtest lab* and *Publish your own* are quiet links in the fine print.
- **Bot detail** — **Use on Trade** (makes it your analyst) and **Add analyst**; what it does, how it decides, its recent signals, then its track record; parameters, model runs and versions sit in a collapsed *Technical details*.
- **Portfolio** — Paper or Live. One big number (the paper balance, or the wallet's balances), then Positions (Close only for the mode you're trading in) and Activity. *Reset paper account* is a quiet link.
- **Settings** — *Trade amounts* (the presets above Buy and Sell; max slippage and the large-trade confirmation for Live), AI analysts (`pnpm setup:ai`, per-provider state), Wallet & network, Display, Help (**Replay the tour**), and a collapsed Diagnostics section for whoever runs the server.
- **Landing (`/`)** — the hero, three steps and the honest part. The primary action is *Start with paper money*.

| | |
|---|---|
| ![Bots](screenshots/desktop-bots.png) | ![Portfolio](screenshots/desktop-portfolio.png) |

## Brand

The full identity lives in [`brand/`](../brand) (guidelines, logos, tokens) and on the in-app `/brand` page. The idea is **"Bots call it. You make the call."** — loud about the tool, sober about the market.

![Landing page](screenshots/desktop-landing.png)

- **Logo.** "SIGNALOS" in Anton, slanted 12°, heavy and condensed, followed by a glossy blue infinity ribbon (signals that never stop, looped through your decision). Ink on the sky header; white on navy. `node brand/scripts/build-logos.mjs` outlines the wordmark, so the SVGs don't depend on any font.
- **One world.** The marketing site and the product share the sky header, the deep-navy surfaces and the glossy mark.

## System

- **Surfaces.** Near-black with a cold blue cast (`#05090d`), cards one step up (`#0c1216`) with 12–16 px radii and hairline borders — used sparingly; spacing separates things before lines do. Selection is navy blue (`#0f294c`). An optional light theme keeps every colour job and is toggled from the footer or Settings.
- **Colour roles.**
  - Mint `#19d99f` is buy and profit; red `#f0445a` is sell and loss. Nothing else uses them — "new" and "time left" are sky or white, never mint.
  - Sky `#4eb7fa` is the header and brand surface; blue `#2f95ff` is primary actions (Ask), selection, AI at work and Paper.
  - **Live** is pink `#ff4fa8`: the header gets a pink edge and the switch reads *Live · real funds*.
  - Bot identity hues are folded out of the green and red bands by `safeHue()`.
  - Direction is never shown by colour alone: every signal says BUY or SELL (and ▲/▼ in lists).
- **Type.** Anton (slanted, uppercase) for the wordmark and page titles; Geist for the interface; Geist Mono (tabular, slashed zero) for data-dense numbers. All SIL OFL.
- **Analyst identity.** Each bot is its geometric glyph rendered as a glossy "jelly" tube in its hue. Glyphs come only from the built-in set, never from user-supplied markup.
- **Motion.** A new signal ripples in at its price, the dot drops on a spring and its tag rises on its stem. Tokens of 120/200/360/640 ms all drop to 0 under reduced motion (system or Settings). No celebratory motion on trades.
- **Accessibility.** Markers, tags and pills are real buttons with descriptive labels; presets are a radio group; glossary terms explain themselves on hover and focus; the flow works from the keyboard (`/` `⌘K` `1–6` `[` `]` `Esc` `?`); focus rings are visible on both the sky header and dark surfaces.
- **Tour anchors.** `data-tour` marks what the guided tour points at: `markets`, `chart`, `analyst`, `signal-card`, `ask`, `amount`, `trade`, `positions`, `mode-switch`, `wallet`, `help`.

## Honest by design

The UI never shows a submitted transaction as a trade. It labels simulated data where it appears, and a missing number is "—", never a guess. Button labels never round a holding up (a $99.93 holding is *Sell all · $99*). Model conviction is never presented as a probability, signals always say "Not investment advice", a performance number always carries its sample and period and says whether it's a backtest or a forward record, and where there is no record the UI shows none.
