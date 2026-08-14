import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { abiPullTargets, pullAbi } from './abi-pull.js';
import { loadRegistry } from './registry.js';
try {
  const launchpad = process.argv[2];
  if (!launchpad || !/^[a-z][a-z0-9-]*$/.test(launchpad)) throw new Error('Usage: pnpm --filter @eko/chain abi:pull <launchpad>');
  if (!process.env.BLOCKSCOUT_API_KEY) throw new Error(`The explorer is behind a bot check. Set BLOCKSCOUT_API_KEY or use the verified fragments in packages/chain/abi/${launchpad}/. No scraping is attempted.`);
  const targets = abiPullTargets(loadRegistry(), launchpad);
  for (const target of targets) {
    const abi = await pullAbi(target.address, process.env.BLOCKSCOUT_API_KEY, fetch);
    const dir = fileURLToPath(new URL(`../abi/${launchpad}/`, import.meta.url));
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}${target.name}.json`, `${JSON.stringify(abi, null, 2)}\n`);
    console.log(`Wrote abi/${launchpad}/${target.name}.json`);
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
