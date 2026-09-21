import { spawnSync } from 'node:child_process';

const result = spawnSync('forge', ['test'], { stdio: 'inherit' });
if (result.error?.code === 'ENOENT') {
  if (process.env.CI !== undefined) {
    console.error('@eko/contracts: Forge is required in CI but is not on PATH.');
    process.exitCode = 1;
  } else {
    console.log('@eko/contracts: skipping Foundry tests because forge is not on PATH.');
  }
} else if (result.error) {
  throw result.error;
} else {
  process.exitCode = result.status ?? 1;
}
