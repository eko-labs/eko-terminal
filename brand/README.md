# SignalOS brand kit

**Bots call it. You make the call.**

This folder is the source of truth for the SignalOS identity. The live, interactive version is the `/brand` page in the web app, and the landing page is `/`.

| Folder | What's inside |
|---|---|
| `logo/` | Outlined SVGs: symbol (brand, buy and sell states), wordmark, horizontal and stacked lockups in 7 colorways, app icons, favicon |
| `png/` | PNG exports: lockups and symbols @2x, and app icons at 1024, 512, 192, 180, 64 and 32 |
| `social/` | Ready-to-post images: Open Graph, X header, 1080² posts, 1080×1350 post, story, LinkedIn banner, 18×24 poster |
| `stickers/` | Transparent sticker sheet: slogans, the pin and the 11-bot crew |
| `tokens/` | `tokens.json` and `tokens.css`: colors with their jobs, product surfaces, type and radii |
| `fonts/` | Bricolage Grotesque, Geist and Geist Mono (variable WOFF2), each with its SIL OFL license |
| `copy/` | `COPY_DECK.md`: positioning, taglines, manifesto, launch thread, Product Hunt, press release, email, ads, claims guardrails |
| `templates/` | HTML sources for every social asset and the sticker sheet |
| `video/` | Launch film project (~33 s, 1920×1080), built with the chaos-to-order engine and real app captures. Render with `cd brand/video && node render.mjs`; the output is `out/video.mp4` (git-ignored) |
| `GUIDELINES.md` | The rules: logo, color, type, voice and motion |

## Rebuild

```bash
pnpm brand:build
```

This does two things:

- `build-logos.mjs` outlines the wordmark from Bricolage Grotesque, so the SVGs don't depend on any font.
- `build-kit.mjs` renders the PNGs and templates through Playwright, using the locally installed Chrome. It then copies everything to `apps/web/public/brand/` and writes `signalos-brand-kit.zip`.

To change a social asset, edit `templates/social.html` and rebuild.
