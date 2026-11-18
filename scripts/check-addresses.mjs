import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
// TODO(spec): Heritage testnet deployments in packages/shared/src/networks.ts may be allowlisted here
// only after confirming they are not 4663 mainnet addresses. There are currently no such literals.
const heritageTestnet = new Map();
export function addressViolations(files, registryText) {
  const allowed = new Set((registryText.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []).map(a => a.toLowerCase()));
  // Sentinels, not contracts: zero, the common burn address, address one (Montra names it as a launch's holder-fee
  // recipient) and address two (v4-periphery's ADDRESS_THIS: the router itself).
  allowed.add(`0x${'0'.repeat(40)}`); allowed.add(`0x${'0'.repeat(36)}dead`); allowed.add(`0x${'0'.repeat(39)}1`); allowed.add(`0x${'0'.repeat(39)}2`);
  // Robinhood Chain contracts the edge reads that the registry schema has no entry for yet (measured on chain
  // 2026-11-17, chains/robinhood/profile.ts): the WETH/USDG pool behind the ETH price cross-check, and the Pons launch
  // locker and v4 PositionManager that hold each graduation's liquidity.
  // TODO(spec): move them into addresses.4663.yaml once its schema has places for them.
  for (const a of ['0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca', '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952', '0x58daec3116aae6D93017bAAea7749052E8a04fA7']) allowed.add(a.toLowerCase());
  // Pangea's launcher, pool hook and liquidity manager (measured on chain 2026-11-18, chains/robinhood/profile.ts PANGEA;
  // docs/robinhood/CHAIN-FACTS.md §7). TODO(spec): move them into addresses.4663.yaml with the others above.
  for (const a of ['0xaA61764BD44df5468CaaE856232Ce9B711512449', '0x8e1Bf182a2a1FEdF9850379127D4535F18EA68cc', '0xbebe68fBfB62E18FBFEbf4365970D192C5f34DC1']) allowed.add(a.toLowerCase());
  return files.flatMap(({ path, text }) => [...text.matchAll(/(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].flatMap(match => {
    const address = match[0].toLowerCase();
    if (allowed.has(address) || heritageTestnet.get(path)?.has(address)) return [];
    return [`${path}:${text.slice(0, match.index).split('\n').length}: ${match[0]} is outside the registry`];
  }));
}
// Raw transport imports outside the centralized wrapper permit bypassing its budget.
export function rpcTransportViolations(files) {
  return files.flatMap(({ path, text }) => {
    if (path === 'packages/chain/src/rpc/metered.ts') return [];
    return [...text.matchAll(/import\s+(?:[\s\S]*?\s+from\s+)?['"]viem['"]/g)].flatMap(match => {
      if (!/\b(?:http|webSocket)\b|\*\s+as/.test(match[0])) return [];
      // Wallet-only browser transports do not use a server-paid endpoint.
      if (path === 'apps/web/src/lib/wallet.ts' && !/createPublicClient/.test(text)) return [];
      return [`${path}: raw viem transport bypasses the RPC spend guard`];
    });
  });
}
export function sourceFiles(dir, base = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (/^(tests?|__tests__|fixtures?|__fixtures__|mocks?|__mocks__|docs)$/.test(entry.name)) return [];
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, base);
    if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|svelte|vue|html|css|sql)$/.test(entry.name) || /\.(?:test|spec|mock|fixture)\./.test(entry.name)) return [];
    return [{ path: relative(base, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }];
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = ['packages', 'apps'].flatMap(area => readdirSync(resolve(root, area)).flatMap(name => {
    const dir = resolve(root, area, name, 'src');
    try { return sourceFiles(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }));
  // Every chain's registry is a source of truth: Robinhood Chain (4663) while it remains, and Elysium (99901).
  const registries = readdirSync(resolve(root, 'packages/chain')).filter(n => /^addresses\.\d+\.yaml$/.test(n)).sort();
  const registryText = registries.map(n => readFileSync(resolve(root, 'packages/chain', n), 'utf8')).join('\n');
  const failures = [...addressViolations(files, registryText), ...rpcTransportViolations(files)];
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log(`check:addresses passed (${files.length} source files; ${registries.join(', ')})`);
}
