// Bundles implemented image roles and their workspace imports into dist/.
// Runtime dependencies stay external and are installed from package.json in production.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleBuildInfo } from '../../scripts/lib/staging-identity.mjs';
import guardCodeFiles from '../engines/src/guard-code-files.json' with { type: 'json' };
import signalCodeFiles from '../engines/src/signal-code-files.json' with { type: 'json' };
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@eko/'));
const revision = process.env.EKO_SOURCE_REVISION || null;
if (revision !== null && !/^[a-f0-9]{40}$/.test(revision)) throw new Error('EKO_SOURCE_REVISION must be a full lowercase Git SHA');
rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });

await build({
  // Stable root/entry order/target, no env substitution, timestamps or absolute
  // paths in bundles. Single-file ESM bundles; source maps are separate artifacts.
  absWorkingDir: dirname(fileURLToPath(import.meta.url)),
  entryPoints: {
    index: 'src/index.ts',
    launch: 'src/launch.ts',
    'build-identity': 'src/build-identity.ts',
    indexer: '../indexer/src/cli.ts',
    engines: '../engines/src/cli.ts',
    receipts: '../engines/src/receipts/cli.ts',
    mcp: '../mcp/src/cli.ts',
    'census-eval': 'src/ops/census-eval-cli.ts',
    'raw-history-repartition-seal': 'src/db/raw-history-repartition-seal-cli.ts',
    'db/migrate-cli': 'src/db/migrate-cli.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  splitting: false,
  external,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

// Metadata is written after hashing every executable entry/role bundle. Neither
// the revision nor this file is embedded in a bundle (no hash self-reference).
writeFileSync(new URL('./dist/build-info.json', import.meta.url), `${JSON.stringify(bundleBuildInfo(fileURLToPath(new URL('./dist', import.meta.url)), revision))}\n`);

cpSync(new URL('../../packages/db/drizzle', import.meta.url), new URL('./dist/chain-drizzle', import.meta.url), { recursive: true });
cpSync(new URL('../../packages/chain/addresses.4663.yaml', import.meta.url), new URL('./dist/addresses.4663.yaml', import.meta.url));
cpSync(new URL('./config/trading-caps.yaml', import.meta.url), new URL('./dist/trading-caps.yaml', import.meta.url));
cpSync(new URL('../../packages/chain/abi', import.meta.url), new URL('./dist/abi', import.meta.url), { recursive: true });
// Raw worker + OFL fonts stay beside bundled entry points in the runtime image.
cpSync(new URL('../og-renderer/src/og-assets', import.meta.url), new URL('./dist/og-assets', import.meta.url), { recursive: true });

// Retain the exact Guard and Signal implementation bytes hashed by source and bundled engines.
for (const file of [...guardCodeFiles, ...signalCodeFiles]) {
  mkdirSync(new URL(`./dist/guard-code/${file.slice(0, file.lastIndexOf('/') + 1)}`, import.meta.url), { recursive: true });
  cpSync(new URL(`../../${file}`, import.meta.url), new URL(`./dist/guard-code/${file}`, import.meta.url));
}
