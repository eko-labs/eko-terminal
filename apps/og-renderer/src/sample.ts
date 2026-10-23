import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createOgRenderer, type ShareCard } from './index.js';

// Reuse the workspace's existing tsx runner; no new runtime dependency.
const directory = process.argv[2] ? resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2]) : tmpdir();
await mkdir(directory, { recursive: true });
const examples = [
  ['clear', 'Clear'], ['monitor', 'Monitor'], ['danger', 'Danger'], ['not-fully-checked', 'Not fully checked'],
] as const;
const renderer = await createOgRenderer();
try {
  for (const [slug, label] of examples) {
    const incomplete = slug === 'not-fully-checked';
    const card: ShareCard = {
      title: 'Buyer risk snapshot', name: 'Sample token', symbol: 'DEMO', label,
      gap: incomplete ? 'Coverage unavailable · required checks pending' : 'Snapshot coverage · see the full scan',
      details: [
        `Top playbook: ${incomplete ? 'unavailable' : 'No matching playbook'}`,
        `Agent share (beta): ${incomplete ? 'unavailable' : '24.8%'} · confidence ${incomplete ? 'unavailable' : '82.0%'}`,
        `Exit cost ($1,000): ${incomplete ? 'unavailable' : '2.4%'}`,
      ],
      block: '12345678', receipt: 'sample-receipt',
    };
    for (const format of ['share', 'reply'] as const) {
      const image = await renderer.render(card, format);
      const path = join(directory, `${slug}-${format}.png`);
      await writeFile(path, image.png);
      console.log(path);
    }
  }
} finally { await renderer.close(); }
