import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
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
// The edge serves dist as it is (@fastify/static, preCompressed): text files get .br and .gz siblings here, once, at the
// best levels, instead of being compressed per request. index.html is served from memory and compressed by the edge.
const precompress = (): Plugin => {
  let outDir = '';
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  return { name: 'eko-precompress', apply: 'build', enforce: 'post',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    closeBundle() {
      for (const file of walk(outDir)) {
        if (!/\.(?:js|mjs|css|svg|json|webmanifest|ttf|txt)$/.test(file) || /\.map$|budget-/.test(file)) continue;
        const data = fs.readFileSync(file);
        if (data.length < 1024) continue;
        fs.writeFileSync(`${file}.br`, brotliCompressSync(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length } }));
        fs.writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
      }
    } };
};
// The Scan landing, the terminal shell (TerminalApp) and each page are dynamic imports, so the browser met them one
// after another: the entry ran, then asked for the shell, which then asked for the page. A small inline script in the
// head now starts those downloads with the entry's: the Scan landing's on "/" and "/scan", elsewhere the shell's plus
// the page's for the busiest routes.
const PRELOAD_PAGES: [RegExp, string][] = [[/^\/radar$/, '/src/pages/terminal/Radar.tsx'], [/^\/coin\//, '/src/pages/terminal/Coin.tsx'],
  [/^\/pairs$/, '/src/pages/terminal/Pairs.tsx'], [/^\/feed$/, '/src/pages/terminal/Feed.tsx']];
const shellPreload = (): Plugin => ({ name: 'eko-shell-preload', apply: 'build', enforce: 'post', transformIndexHtml: { order: 'post', handler(_html, ctx) {
  const bundle = ctx.bundle;
  if (!bundle) return;
  const chunks = Object.values(bundle).filter(c => c.type === 'chunk');
  const facade = (module: string) => chunks.find(c => c.facadeModuleId?.endsWith(module));
  const entry = chunks.find(c => c.isEntry), shell = facade('/src/TerminalApp.tsx');
  if (!entry || !shell) throw new Error('shell preload: entry or TerminalApp chunk not found');
  const byName = new Map(chunks.map(c => [c.fileName, c]));
  const closure = (file: string, seen = new Set<string>()): Set<string> => { if (!seen.has(file)) { seen.add(file); byName.get(file)?.imports.forEach(f => closure(f, seen)); } return seen; };
  const loaded = closure(entry.fileName);
  // [rel, href] pairs for a chunk's static closure (JS as modulepreload, its CSS as a style preload), minus `skip`.
  const links = (file: string, skip: Set<string>) => {
    const js = [...closure(file)].filter(f => !skip.has(f));
    const css = [...new Set(js.flatMap(f => [...(byName.get(f)?.viteMetadata?.importedCss ?? [])]))];
    return [...js.map(f => ['modulepreload', `/${f}`]), ...css.map(f => ['preload', `/${f}`])];
  };
  const shellSkip = new Set([...loaded, ...closure(shell.fileName)]);
  const pages = PRELOAD_PAGES.map(([pattern, module]) => {
    const page = facade(module);
    if (!page) throw new Error(`shell preload: no chunk for ${module}`);
    return [pattern.source, links(page.fileName, shellSkip)];
  });
  const scan = facade('/src/pages/scan/Landing.tsx');
  if (!scan) throw new Error('shell preload: no chunk for the Scan landing');
  const data = JSON.stringify({ scan: links(scan.fileName, loaded), shell: links(shell.fileName, loaded), pages });
  return [{ tag: 'script', injectTo: 'head', children: `(()=>{const p=location.pathname,d=${data},all=/^\\/(scan)?$/.test(p)?d.scan:[...d.shell];if(all!==d.scan)for(const[s,l]of d.pages)if(new RegExp(s).test(p))all.push(...l);for(const[r,h]of all){const l=document.createElement('link');l.rel=r;l.href=h;l.crossOrigin='';if(r==='preload')l.as='style';document.head.append(l)}})()` }];
} } });
const landing = (): Plugin => ({ name: 'eko-landing', configureServer: (s) => { s.middlewares.use(serveLanding()); }, configurePreviewServer: (s) => { s.middlewares.use(serveLanding()); } });

const api = process.env.EKO_API ?? 'http://localhost:8710';
// A remote API (for example staging) routes by Host, so the dev proxy must send the target's host.
const remote = api.startsWith('https://');

export default defineConfig({
  plugins: [react(), chainHtml(), landing(), pwa(), budgetGraph(), shellPreload(), precompress()],
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
