# EKO landing

The marketing site and interactive docs. Built with Vite under the `/site/` base; in production the API serves
`dist/index.html` at `/`, its files under `/site/` and `dist/docs.html` at `/site/docs.html` (`LANDING_DIST_DIR`).
The terminal keeps every other path. The hero and closing previews read the web app's demo radar profiles.

```sh
pnpm --filter @eko/landing build
```

Local combined preview: `EKO_SITE=../landing/dist WEB_PORT=5183 pnpm --filter @eko/web dev`, then open `/`.

## Third-party assets

- Inter Tight and Fragment Mono: SIL Open Font License 1.1 (`public/fonts/OFL-*.txt`), self-hosted latin subsets.
- Ague Thin (Zafira Type, all rights reserved): licensed for the hosted site only, so it is kept out of the public
  repository and added at deploy time. Without it the `src` lists fall back to Outfit (SIL OFL, `OFL-Outfit.txt`).
- `public/media/template/`: imagery and video from the landing template the design adapts, self-hosted.
