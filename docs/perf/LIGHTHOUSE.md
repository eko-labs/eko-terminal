# Lighthouse: landing and terminal (Robinhood build), November 2026

**How it was measured.** These are Robinhood builds (`VITE_EKO_CHAIN=robinhood`) of `apps/web` and `apps/landing`, served the way production serves them. The local edge ran with `EKO_CHAIN=robinhood`, the public RPC, `HISTORIAN=off` and `TRADING=off`, with `WEB_DIST` and `LANDING_DIST` pointing at the builds. The baseline build is byte-identical to what ekoterminal.com serves: same asset hashes, and like the live site it sends no compression.

The runs used Lighthouse 12 in headless Chrome, with the default mobile preset (simulated slow 4G and a 4× CPU slowdown) and the desktop preset. Each run covered performance, accessibility, best practices and SEO. The coin page tested was a graduated Pons coin.

Scores are listed as performance / accessibility / best practices / SEO.

| Page | Preset | Before | After | LCP before → after | CLS before → after | TBT before → after |
|---|---|---|---|---|---|---|
| `/` landing | mobile | 38 / 100 / 100 / 100 | **92** / 100 / 100 / 100 | 7.0 s → 3.1 s | 0.003 → 0 | 1,510 → 50 ms |
| `/` landing | desktop | 97 / 100 / 100 / 100 | **100** / 100 / 100 / 100 | 1.2 → 0.7 s | 0 → 0 | 20 → 0 ms |
| `/radar` | mobile | 21 / 100 / 96 / 91 | **66** / 100 / 96 / 91 | 8.4 → 3.6 s | 0.446 → 0.28 ¹ | 820 → 310 ms |
| `/radar` | desktop | 73 / 96 / 96 / 91 | **99** / 96 / 96 / 91 | 1.7 → 0.8 s | 0.296 → 0.06 | 140 → 50 ms |
| `/coin/<address>` | mobile | 56 / 95 / 96 / 91 | **78** / 95 / 96 / 91 | 9.3 → 4.1 s | 0.119 → 0.147 ¹ | 10 → 20 ms |
| `/coin/<address>` | desktop | 67 / 92 / 96 / 91 | **77–94** ¹ / 92 / 96 / 91 | 1.9 → 0.8 s | 0.535 → 0.13–0.54 ¹ | 0 → 0 ms |

Page weight on a first visit:

| Page | Before | After |
|---|---|---|
| Landing | 9,475 KiB | 817 KiB |
| Radar | 1,192 KiB | 364 KiB |
| Coin | 1,283 KiB | 389 KiB |

¹ The remaining terminal CLS comes from the pages themselves, and the faster first paint now exposes it.
- **Radar:** the table's wrapper (`.rt-wrap`) changes height when `/v2/radar` and `/v1/config` arrive, and the footer notice collapses.
- **Coin:** `.coin-grid` and the sidebar footer move when `/v1/config` arrives. Across repeated runs the coin page on desktop gives either 0.13 or 0.54.

Reserving that space belongs to the pages' owners (see the list below).

## What changed

**Edge** (`apps/edge/src/server.ts`)
- Nothing was compressed before, because Railway passes responses through as they are.
- Compressing JSON and HTML:
  - The edge now compresses JSON and HTML over 1 KB in an `onSend` hook: brotli at level 4, or gzip for clients without brotli.
  - The hook is added first, so every route gets it.
  - It runs synchronously, so it needs no plugin and no particular registration order. (`@fastify/compress`, when registered in a synchronous `buildServer`, missed the routes declared before it loaded.)
- Built files:
  - The web and landing builds are served from their `.br` and `.gz` siblings (`@fastify/static` `preCompressed`).
  - Hashed assets stay immutable.
  - Fonts and `/site/media` get 30 days of caching plus one day of `stale-while-revalidate`.
- Tests: `apps/edge/test/static-compression.test.ts`.

**Landing** (`apps/landing`)
- Media re-encoding:
  - The signal-field video went from 6.2 MB to 1.3 MB.
  - The flight-recorder video went from 34 MB to 12.8 MB.
  - The hero glow video went from 1.2 MB to 178 KB. It is only sampled into a dot grid, so 480 px wide is enough.
  - The halftone textures went from 663 KB and 584 KB to 99 KB and 141 KB.
  - The posters are smaller.
  - `DotMatrix` gained `cropBasis`, so crops stay in the original texture's pixels.
- `DotMatrix` work:
  - It used to resample its video and read layout on every frame.
  - It now samples at most every 66 ms and measures only on start, on resize and twice a second.
  - Under the opening animation (an inert ancestor) it draws once and waits.
  - The signal-field video now waits until the intro lifts.
  - On a throttled mobile load, main-thread script time fell from about 3.3 s to about 0.6 s.
- Layout: the fit-to-width hooks measured only inside a `ResizeObserver`, so the mobile hero painted at height 0 and pushed the page down. CLS was 0.62 once the page painted early. The hooks are now one shared `lib/fitScale` that measures in a layout effect.
- Headline font: preloaded.
- Lazy loading: the roadmap image now loads lazily.
- Broken paths: two mobile backgrounds pointed at `/media/…` instead of `/site/media/…` and never loaded. Fixed.
- Precompression: the build writes `.br` and `.gz` files.

**Terminal** (`apps/web/vite.config.ts`, `index.html`, `src/main.tsx`)
- Precompressed build.
- Lazy Scan landing:
  - `main.tsx` imported the Scan landing statically. That put it, plus `@eko/shared` with zod, into every page's entry: 143.7 KB gzip against the 90 KB landing budget.
  - It is now lazy, the entry closure is 72 KB, and `scripts/check-web-budgets.mjs` passes.
- Preloading:
  - A small inline head script starts the next downloads at the same time as the entry instead of one after another.
  - On `/` and `/scan` it fetches the Scan landing.
  - On other pages it fetches `TerminalApp`, plus the page's chunk for `/radar`, `/coin/*`, `/pairs` and `/feed`.
- Syne (the page-title font) is preloaded.

**Colour.** The landing's dither dots and glows used the light accent `#8fcaf0` at full strength, which read as light cyan. The terminal keeps that accent for marks and controls. The dots now take a ramp of the terminal's deep blues (new tokens `--eko-dot-lo`, `--eko-dot-mid`, `--eko-dot-hi`: `#0c2233`, `#2c5673`, `#5d9fd3`). The glows use the terminal's page-glow blue `#2f95ff`.

## Left for the owners of those files

- **Wallet code on Radar and Pairs.**
  - `lib/tradeFlow.ts` imports `isUserRejection` and `newIdempotencyKey` from `lib/trade.ts`, which imports `wagmi/actions` and `lib/wallet`.
  - Through that import, every page that shows a Trade button (Radar, Pairs) loads wagmi and viem: the `actions` chunk is 253 KB raw and 61 KB br, and 77% of it goes unused on `/radar`. `wallet-abi` and `wallet` load with it.
  - Fix: move those two helpers into a wallet-free module.
- **Meta description.** `lib/share.ts` `applyShareMeta(null)` removes the `index.html` description and adds none, so every terminal page fails Lighthouse's meta-description check (SEO 91).
- **Console errors.**
  - The Robinhood edge has no `/v1/share-meta` route, so it returns 404s.
  - `/v1/me` returns 401 when signed out.
  - Both fail Lighthouse's console-errors check (best practices 96).
- **CLS (layout shift).**
  - Radar: `.rt-wrap` and `.hot-strip` need reserved space.
  - Coin: `.coin-grid` and the sidebar footer change height when `/v1/config` arrives.
- **Accessibility.**
  - Sidebar `nav.policy-links` links are under the 24 px target size (all pages).
  - Coin page:
    - `aria-prohibited-attr` on `.cc-scale`.
    - `heading-order` (an `h3` in `#coin-evidence`).
    - `label-content-name-mismatch` on `.coin-verdict-button`.
- **Render-blocking CSS.**
  - `main.tsx` loads all of the terminal's CSS up front: 101 KB, of which 87% is unused on `/radar`.
  - Splitting route CSS (chart, ticket, lab) would need the stylesheets' owners to agree, because their cascade order would change.
- **Service worker.** `TerminalApp` registers it on mount, so its precache downloads compete with the first load. Registering it after `load` and on idle would avoid that.
- **Unused landing media.** `eko-flight-recorder-wan.mp4` (8 MB) is referenced nowhere.
