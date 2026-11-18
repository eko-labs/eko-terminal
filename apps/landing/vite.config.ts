import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// The edge serves dist as it is (@fastify/static, preCompressed): text files get .br and .gz siblings here, once, at
// the best levels, instead of being compressed per request. The HTML pages are served from memory and compressed there.
function precompress(): Plugin {
  let outDir = ''
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  return {
    name: 'eko-precompress',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      for (const file of walk(outDir)) {
        if (!/\.(?:js|css|svg|json|txt)$/.test(file)) continue
        const data = fs.readFileSync(file)
        if (data.length < 1024) continue
        fs.writeFileSync(`${file}.br`, brotliCompressSync(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length } }))
        fs.writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }))
      }
    },
  }
}

// One landing build per chain: VITE_EKO_CHAIN (Dockerfile.edge passes EKO_CHAIN) picks the copy in src/chain.ts.
// index.html is the Elysium page as it has always been and an Elysium build leaves it untouched; a Robinhood build
// swaps its description meta for the Robinhood one (the non-affiliation line the earlier Robinhood landing used).
const ROBINHOOD_DESCRIPTION = 'The harness your trading agent runs inside. Built on Robinhood Chain. Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.'

function chainHtml(chain: string | undefined): Plugin {
  return {
    name: 'eko-chain-html',
    transformIndexHtml(html, ctx) {
      if (chain !== 'robinhood' || !/(^|\/)index\.html$/.test(ctx.filename)) return html
      const next = html.replace(/(<meta name="description" content=")[^"]*(")/, `$1${ROBINHOOD_DESCRIPTION}$2`)
      if (next === html) throw new Error('index.html has no description meta for the Robinhood build to replace')
      // Link previews (X, Telegram, Discord) for ekoterminal.com itself.
      const share = ['<meta property="og:type" content="website" />', '<meta property="og:site_name" content="EKO" />',
        '<meta property="og:url" content="https://ekoterminal.com/" />', '<meta property="og:title" content="EKO — Every move has a cause." />',
        `<meta property="og:description" content="${ROBINHOOD_DESCRIPTION}" />`, '<meta property="og:image" content="https://ekoterminal.com/icons/eko-512.png" />',
        '<meta name="twitter:card" content="summary" />'].join('\n    ')
      return next.replace(/(<meta name="description"[^>]*>)/, `$1\n    ${share}`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: '/site/',
  plugins: [react(), tailwindcss(), chainHtml(loadEnv(mode, process.cwd(), 'VITE_').VITE_EKO_CHAIN), precompress()],
  build: { rolldownOptions: { input: { main: 'index.html', docs: 'docs.html', whitepaper: 'whitepaper.html' } } },
}))
