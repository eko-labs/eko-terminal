#!/usr/bin/env node
/* Render the composition to MP4 (or stills / a contact sheet) with headless Chrome + ffmpeg.
 *
 *   node render.mjs                        full video → out/video.mp4
 *   node render.mjs --draft                half resolution, faster
 *   node render.mjs --from 8 --to 14       render a time range
 *   node render.mjs --stills 1.2,9.4,15    PNG stills at those times → out/stills/
 *   node render.mjs --sheet 16             one contact sheet of 16 evenly spaced frames → out/sheet.png
 *   node render.mjs --sheet --times 3.3,9.5,13.6   contact sheet of exactly those times
 *   node render.mjs --audio music.mp3      mux an audio track (trimmed to the video)
 *   node render.mjs --preview              serve the interactive player and print its URL
 *
 * Chrome: uses $CHROME_PATH, else a system Chrome/Chromium/Edge install.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

function serve(port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
      let file = path.join(ROOT, url === '/' ? 'index.html' : url);
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        // Byte ranges let <video> seek inside films.
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        if (m) {
          const start = m[1] ? +m[1] : st.size - +m[2], end = m[1] && m[2] ? +m[2] : st.size - 1;
          res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
          return fs.createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const c = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  }[process.platform] || [];
  const hit = c.find((p) => fs.existsSync(p));
  if (hit) return hit;
  throw new Error('No Chrome found. Install Google Chrome, or set CHROME_PATH, or run: npx @puppeteer/browsers install chrome-headless-shell@stable');
}

async function main() {
  const server = await serve(flag('preview') ? Number(opt('port', 5317)) : 0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  if (flag('preview')) {
    console.log(`Preview player: ${base}\n(Ctrl+C to stop)`);
    if (!flag('no-open')) { try { execFileSync(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [base]); } catch {} }
    return;
  }

  const { default: puppeteer } = await import('puppeteer-core');
  const { default: ffmpegPath } = await import('ffmpeg-static');
  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless: true,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { if (['error', 'warn'].includes(m.type()) && !/willReadFrequently/.test(m.text())) console.log('[page]', m.text()); });
    page.on('pageerror', (e) => console.log('[page error]', e.message));
    const cfgSize = await (async () => { await page.goto(base + 'index.html?render=1', { waitUntil: 'load' }); return page.evaluate(() => (window.VIDEO && window.VIDEO.size) || [1920, 1080]); })();
    const [W, H] = cfgSize;
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.waitForFunction('window.__ready === true || window.__bootError', { timeout: 180000 });
    const bootErr = await page.evaluate(() => window.__bootError);
    if (bootErr) throw new Error('Composition failed to boot:\n' + bootErr);
    const DURATION = await page.evaluate(() => window.DURATION);
    const FPS = Number(opt('fps', await page.evaluate(() => window.FPS)));
    const cdp = await page.createCDPSession();
    const scale = flag('draft') ? 0.5 : Number(opt('scale', 1));
    const outDir = path.join(ROOT, 'out');
    fs.mkdirSync(outDir, { recursive: true });

    const grab = async (t, format = 'jpeg', stamp = null) => {
      await page.evaluate(async (t, stamp) => {
        await window.renderFrame(t);
        let s = document.getElementById('__stamp');
        if (stamp) { if (!s) { s = document.createElement('div'); s.id = '__stamp'; Object.assign(s.style, { position: 'fixed', left: '10px', top: '10px', zIndex: 9999, background: '#ff0', color: '#000', font: 'bold 28px monospace', padding: '2px 8px' }); document.body.appendChild(s); } s.textContent = stamp; }
        else if (s) s.remove();
        await new Promise((r) => requestAnimationFrame(() => r()));
      }, t, stamp);
      const { data } = await cdp.send('Page.captureScreenshot', { format, quality: format === 'jpeg' ? 92 : undefined, clip: { x: 0, y: 0, width: W, height: H, scale }, optimizeForSpeed: true });
      return Buffer.from(data, 'base64');
    };

    // Stills
    if (opt('stills')) {
      const dir = path.join(outDir, 'stills'); fs.mkdirSync(dir, { recursive: true });
      for (const ts of opt('stills').split(',').map(Number)) {
        const f = path.join(dir, `t${ts.toFixed(2).padStart(6, '0')}.png`);
        fs.writeFileSync(f, await grab(ts, 'png'));
        console.log('wrote', path.relative(process.cwd(), f));
      }
      return;
    }
    // Contact sheet
    if (flag('sheet')) {
      const from = Number(opt('from', 0)), to = Number(opt('to', DURATION));
      const n = Number(opt('sheet', 16));
      const times = opt('times') ? opt('times').split(',').map(Number) : Array.from({ length: n }, (_, i) => from + (to - from) * (i + 0.5) / n);
      const cols = Number(opt('cols', Math.min(4, times.length)));
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-'));
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        fs.writeFileSync(path.join(tmp, `f${String(i).padStart(3, '0')}.png`), await grab(t, 'png', t.toFixed(2) + 's'));
      }
      const rows = Math.ceil(times.length / cols), tw = Math.round(1600 / cols);
      const out = path.join(outDir, opt('name', 'sheet') + '.png');
      execFileSync(ffmpegPath, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%03d.png'), '-vf', `scale=${tw}:-1,tile=${cols}x${rows}:padding=4:color=gray`, '-frames:v', '1', out]);
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log('wrote', path.relative(process.cwd(), out));
      return;
    }

    // Video
    const from = Number(opt('from', 0)), to = Math.min(DURATION, Number(opt('to', DURATION)));
    const total = Math.round((to - from) * FPS);
    const out = path.resolve(opt('out', path.join(outDir, 'video.mp4')));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const audio = opt('audio');
    const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-'];
    if (audio) args.push('-ss', String(from), '-i', path.resolve(audio));
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', flag('draft') ? '23' : '17', '-preset', flag('draft') ? 'veryfast' : 'medium', '-movflags', '+faststart', '-r', String(FPS));
    if (audio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    args.push(out);
    const ff = spawn(ffmpegPath, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    const ffDone = new Promise((res, rej) => ff.on('close', (code) => (code === 0 ? res() : rej(new Error('ffmpeg exited ' + code)))));
    const t0 = Date.now();
    for (let i = 0; i < total; i++) {
      const buf = await grab(from + i / FPS);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % FPS === 0 || i === total - 1) {
        const el = (Date.now() - t0) / 1000, eta = el / (i + 1) * (total - i - 1);
        process.stdout.write(`\rframe ${i + 1}/${total}  ${(from + i / FPS).toFixed(1)}s  eta ${eta.toFixed(0)}s   `);
      }
    }
    ff.stdin.end();
    await ffDone;
    console.log(`\nwrote ${path.relative(process.cwd(), out)}  (${(to - from).toFixed(2)}s @ ${FPS}fps, ${Math.round(W * scale)}x${Math.round(H * scale)})`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
