import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const contractsRoot = new URL('../', import.meta.url);
const build = spawnSync('forge', ['build'], { cwd: contractsRoot, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const artifact = JSON.parse(readFileSync(new URL('out/ReceiptsRegistry.sol/ReceiptsRegistry.json', contractsRoot), 'utf8'));
const destination = new URL('../packages/chain/abi/eko/', contractsRoot);
mkdirSync(destination, { recursive: true });
writeFileSync(new URL('ReceiptsRegistry.json', destination), `${JSON.stringify(artifact.abi, null, 2)}\n`);
console.log('Exported ReceiptsRegistry ABI to packages/chain/abi/eko/ReceiptsRegistry.json');
