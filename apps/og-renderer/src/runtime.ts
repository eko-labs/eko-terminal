import { open, readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { OgRenderer, fontContentHash, type BrandAssets, type BrandFont, type CardNode } from './index.js';

interface Job {
  node: CardNode; width: number; height: number;
  resolve(png: Uint8Array): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One isolated CPU worker, no unbounded queue; deadlines include queue time. */
export class RenderWorker {
  private worker?: Worker;
  private active?: Job;
  private queue: Job[] = [];
  private closed = false;
  constructor(private readonly fonts: BrandFont[], private readonly timeoutMs = 5000,
    private readonly maxQueued = 8, private readonly url = new URL('./og-assets/worker.mjs', import.meta.url)) {}

  readonly rasterize = (node: CardNode, width: number, height: number): Promise<Uint8Array> => {
    if (this.closed) return Promise.reject(new Error('og_renderer_unavailable'));
    if (this.active && this.queue.length >= this.maxQueued) return Promise.reject(new Error('og_renderer_busy'));
    return new Promise((resolve, reject) => {
      const job: Job = { node, width, height, resolve, reject, timer: setTimeout(() => {
        if (this.active === job) void this.reset(new Error('og_renderer_timeout'));
        else { this.queue = this.queue.filter(item => item !== job); reject(new Error('og_renderer_timeout')); }
      }, this.timeoutMs) };
      this.queue.push(job); this.pump();
    });
  };

  private pump() {
    if (this.closed || this.active || !this.queue.length) return;
    this.active = this.queue.shift()!;
    try {
      if (!this.worker) {
        const worker = this.worker = new Worker(this.url, {
          workerData: { fonts: this.fonts }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 },
        });
        worker.on('message', (result: { png?: Uint8Array; error?: string }) => {
          if (this.worker !== worker || !this.active) return;
          const job = this.active; this.active = undefined; clearTimeout(job.timer);
          if (result.png) job.resolve(result.png); else job.reject(new Error('og_renderer_unavailable', { cause: result.error }));
          this.pump();
          if (!this.active) worker.unref();
        });
        worker.on('error', () => { if (this.worker === worker) void this.reset(new Error('og_renderer_unavailable')); });
        worker.on('exit', () => { if (this.worker === worker) void this.reset(new Error('og_renderer_unavailable')); });
      }
      this.worker.ref();
      this.worker.postMessage({ node: this.active.node, width: this.active.width, height: this.active.height });
    } catch { void this.reset(new Error('og_renderer_unavailable')); }
  }

  private async reset(error: Error) {
    const worker = this.worker; this.worker = undefined;
    for (const job of [this.active, ...this.queue]) {
      if (job) { clearTimeout(job.timer); job.reject(error); }
    }
    this.active = undefined; this.queue = [];
    if (worker) await worker.terminate();
  }
  async close() { this.closed = true; await this.reset(new Error('og_renderer_unavailable')); }
}

const BRAND_FILES = ['eko-mark-stipple-512.png', 'eko-lockup-stipple-960.png', 'eko-ghost-stipple-512.png', 'eko-mark-tight.svg'] as const;
const MAX_ASSET_BYTES = 512 * 1024;
export async function loadBrandAssets(directory = new URL('./og-assets/brand/', import.meta.url)): Promise<{ assets: BrandAssets; bytes: Buffer[] }> {
  const bytes = await Promise.all(BRAND_FILES.map(async file => {
    const handle = await open(new URL(file, directory), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ASSET_BYTES) throw new Error('Invalid brand asset size');
      // Bound the allocation/read even if an asset changes after stat.
      const buffer = Buffer.alloc(MAX_ASSET_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size !== stat.size || size > MAX_ASSET_BYTES) throw new Error('Invalid brand asset size');
      return buffer.subarray(0, size);
    } finally { await handle.close(); }
  }));
  const png = (data: Buffer) => 'data:image/png;base64,' + data.toString('base64');
  return { assets: { mark: png(bytes[0]), ghost: png(bytes[2]) }, bytes };
}

export async function createOgRenderer(): Promise<OgRenderer> {
  // Use the bundled OFL TTFs: satori does not accept the site's WOFF2 files.
  const fonts: BrandFont[] = await Promise.all(([400, 600] as const).map(async weight => ({
    name: 'Syne', weight, style: 'normal' as const,
    data: await readFile(new URL(`./og-assets/fonts/syne-${weight === 400 ? 'regular' : 'semibold'}.ttf`, import.meta.url)),
  })));
  const brand = await loadBrandAssets();
  const worker = new RenderWorker(fonts);
  return new OgRenderer(worker.rasterize, fontContentHash(fonts, brand.bytes), undefined, () => worker.close(), brand.assets);
}
