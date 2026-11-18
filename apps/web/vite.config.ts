import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { pwa } from './build/pwa';
import { budgetGraph } from './build/budget';

// One site: the landing (apps/landing; build it first) is served at "/" and the terminal everywhere
// else. Its files are read unchanged from EKO_SITE; asset paths move under /site/, and public/site-bridge.* adds the
// ways into the terminal. In production the host does the same: the landing's build at "/", this app for other paths.
const SITE = path.resolve(process.env.EKO_SITE ?? path.join(process.cwd(), '../landing/dist'));
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4' };
function serveLanding(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const { pathname } = new URL(req.url ?? '/', 'http://local');
    if (pathname === '/' && fs.existsSync(path.join(SITE, 'index.html'))) {
      const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')
        .replace(/(href|src)="(src|assets)\//g, '$1="/site/$2/')
        .replace('</body>', '<link rel="stylesheet" href="/site-bridge.css"><script type="module" src="/site-bridge.js"></script></body>');
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return;
    }
    if (pathname.startsWith('/site/')) {
      const file = path.join(SITE, decodeURIComponent(pathname.slice(6)));
      if (file.startsWith(SITE + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream'); fs.createReadStream(file).pipe(res); return;
      }
    }
    next();
  };
}
// One web build per chain (VITE_EKO_CHAIN, from Dockerfile.edge). index.html carries the Elysium description; a Robinhood
// build swaps the description and og:description for the Robinhood line, so search results and link previews name the
// right chain and the right non-affiliation.
const ROBINHOOD_DESCRIPTION = 'The harness your trading agent runs inside. Built on Robinhood Chain. Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.';
const chainHtml = (): Plugin => ({ name: 'eko-chain-html', transformIndexHtml(html) {
  if (process.env.VITE_EKO_CHAIN !== 'robinhood') return html;
  const next = html.replace(/(<meta (?:name="description"|property="og:description") content=")[^"]*(")/g, `$1${ROBINHOOD_DESCRIPTION}$2`);
  if ((next.match(/Robinhood Markets, Inc\./g) ?? []).length !== 2) throw new Error('index.html must carry description and og:description metas for the Robinhood build to replace');
  return next;
} });
const landing = (): Plugin => ({ name: 'eko-landing', configureServer: (s) => { s.middlewares.use(serveLanding()); }, configurePreviewServer: (s) => { s.middlewares.use(serveLanding()); } });

const api = process.env.EKO_API ?? 'http://localhost:8710';
// A remote API (for example staging) routes by Host, so the dev proxy must send the target's host.
const remote = api.startsWith('https://');

export default defineConfig({
  plugins: [react(), chainHtml(), landing(), pwa(), budgetGraph()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    proxy: {
      '/v1': { target: api, ws: true, changeOrigin: remote },
      '/v2': { target: api, changeOrigin: remote },
      '/api': { target: api, changeOrigin: remote },
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true, changeOrigin: remote },
    },
  },
  preview: { host: '127.0.0.1', proxy: { '/v1': { target: api, ws: true }, '/v2': { target: api }, '/api': { target: api } } },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500,
    rollupOptions: { output: { manualChunks(id) {
      if (/node_modules\/viem\/_esm\/(utils\/abi|errors\/abi|utils\/cursor)/.test(id)) return 'wallet-abi';
    } } },
  },
});
