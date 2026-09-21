import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

// Reuse the chain workspace's pinned hashing implementation; no new dependency.
const { keccak256 } = createRequire(new URL('../../packages/chain/package.json', import.meta.url))('viem');
const root = new URL('../', import.meta.url);
const recordPath = new URL('release/ReceiptsRegistry.build.json', root);
if (process.argv.slice(2).some(arg => arg !== '--write') || process.argv.slice(2).length > 1) {
  throw new Error('Usage: node scripts/build-record.mjs [--write]');
}
const build = spawnSync('forge', ['build', '--force'], { cwd: root, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const configResult = spawnSync('forge', ['config', '--json'], { cwd: root, encoding: 'utf8' });
if (configResult.error) throw configResult.error;
if (configResult.status !== 0) throw new Error('Cannot read effective Foundry settings');
const config = JSON.parse(configResult.stdout);
const artifact = JSON.parse(readFileSync(new URL('out/ReceiptsRegistry.sol/ReceiptsRegistry.json', root), 'utf8'));
const metadata = JSON.parse(artifact.rawMetadata);
for (const code of [artifact.bytecode, artifact.deployedBytecode]) {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code.object) ||
      Object.keys(code.linkReferences ?? {}).length || Object.keys(code.immutableReferences ?? {}).length) {
    throw new Error('Build record requires fully linked bytecode without immutables');
  }
}
const record = {
  schemaVersion: 1,
  contract: 'src/ReceiptsRegistry.sol:ReceiptsRegistry',
  compiler: metadata.compiler.version,
  settings: {
    optimizer: metadata.settings.optimizer,
    viaIR: metadata.settings.viaIR ?? false,
    evmVersion: metadata.settings.evmVersion,
    metadata: { bytecodeHash: config.bytecode_hash, appendCBOR: config.cbor_metadata },
    libraries: metadata.settings.libraries,
    remappings: metadata.settings.remappings,
  },
  creationCodeHash: keccak256(artifact.bytecode.object),
  runtimeCodeHash: keccak256(artifact.deployedBytecode.object),
  immutableReferences: {},
  constructor: {
    arguments: ['address owner_', 'address committer_'],
    creationCodeHash: 'Hashes creation bytecode only. Deployment init code appends ABI-encoded constructor arguments and has a different hash.',
    runtimeCodeHash: 'No immutables or linked libraries. Constructor arguments set storage only; runtime code hash is independent of owner and committer.',
  },
};
if (process.argv.includes('--write')) {
  mkdirSync(new URL('release/', root), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log('Wrote contracts/release/ReceiptsRegistry.build.json; review before release.');
} else {
  const expected = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (!isDeepStrictEqual(record, expected)) throw new Error('ReceiptsRegistry build differs from committed build record (settings or bytecode hashes)');
  console.log('ReceiptsRegistry build record matches.');
}
console.log(`creation ${record.creationCodeHash}\nruntime  ${record.runtimeCodeHash}`);
