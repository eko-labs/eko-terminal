import { defineConfig } from 'vitest/config';

// Current core census: authorization, private keys/data, unsigned execution, settlement
// and receipt integrity. Paths are repository-relative; unimported files count too.
export const coreFiles = [
  'apps/server/src/{app,config,roles}.ts', // Startup gates and authenticated HTTP/WS wiring are executable decisions.
  'apps/server/src/db/client.ts',
  'apps/server/src/flags/service.ts',
  'apps/server/src/ai/budget.ts',
  'apps/server/src/points/{config,service}.ts', // Account/referral identity and reward accounting.
  'apps/server/src/http/auth.ts',
  'apps/server/src/http/routes.ts', // Mixed legacy router: retain the entire file, conservatively.
  'apps/server/src/http/{share,review-api,ghost-reports}.ts',
  'apps/server/src/http/launch-monitoring.ts',
  'apps/server/src/http/v1/{account,agents,bags,watch,telegram,config,reads,fixtures,demo,helpers,journal,trade,trade-admin,oauth,rpc,telemetry,receipts}.ts',
  'apps/server/src/fixtures/producers.ts', // Dev owner-capability gates remain core even when disabled in production.
  'apps/server/src/http/v1/index.ts', // Registers encapsulated authentication boundaries, not a re-export barrel.
  'apps/server/src/read/bags.ts',
  'apps/server/src/read/receipt-reader.ts',
  'apps/server/src/alerts/*.ts',
  'apps/server/src/telegram/*.ts',
  'apps/server/src/ops/{backup-cli,backup-stream,restore-checks}.ts', // Restore loads journal key material; count operator-only key handling too.
  'apps/server/src/ws/hub.ts',
  'apps/server/src/harness/*.ts',
  'apps/server/src/exec/*.ts',
  'apps/server/src/obs/{incidents,security-collectors,security-config,security-worker}.ts',
  'apps/server/src/proxy-trust.ts',
  'apps/server/src/sanctions/{parser,service}.ts',
  'apps/mcp/src/*.ts',
  'apps/bots/src/{telegram,x,farcaster}/*.ts', // Include disabled transports: implemented identity checks still count.
  'apps/indexer/src/*.ts',
  'apps/engines/src/receipts/{cli,worker}.ts', // CLI contains the production signer, so it remains in scope.
  'apps/engines/src/receipt.ts',
  'packages/db/src/crypto/*.ts',
  'packages/db/src/{receipt-anchors,receipt-api,receipt-committer,receipt-outbox,guard-receipts,client,engines-migrate,market,lock,bus,types,review-store,launch-monitoring,ghost-reports}.ts',
  'packages/receipts-verifier/src/index.ts', // This index contains verification logic, not just exports.
  'packages/chain/src/execution/*.ts',
  'packages/chain/src/{verify,verify-command,build-records,registry,actor,abis,decoders}.ts',
  'packages/chain/src/rpc/*.ts', // Provider identity, budget and failure boundaries used by execution and ingest.
  'packages/chain/src/simulation/{pons,pons-math,reference,v3,v4,anvil}.ts', // Helpers used to construct/bind executable legs.
  'packages/policy/src/*.ts',
  'packages/shared/src/{canonical,schemas,networks,risk,bots,telegram,ws}.ts',
  'packages/shared/src/contracts/{common,auth,harness,entitlements,transactions,guard-v2,guard-ids,versions,receipt-encoding,receipts,public-receipts,guard-receipts,trading,actual-order,oauth,api,share,ws,guard-review}.ts',
];

export default defineConfig({
  test: {
    projects: ['apps/server', 'apps/engines', 'apps/mcp', 'apps/indexer', 'apps/bots', 'packages/db', 'packages/chain', 'packages/policy', 'packages/shared', 'packages/receipts-verifier'].map(root => ({
      // cli.test.ts spawns the engines CLI from the package cwd; a spawned child is not instrumented, and the
      // coverage run starts at the repo root, so that one test runs only in the normal suite. Timing budgets
      // (performance*.test.ts) are meaningless under instrumentation and also run only in the normal suite.
      test: { name: root, root, include: ['test/**/*.test.ts'], exclude: ['test/fork/**', 'test/**/performance*.test.ts', ...(root === 'apps/engines' ? ['test/cli.test.ts'] : [])],
        // V8 instrumentation makes seeded analytics suites slower; normal configs stay unchanged.
        testTimeout: 300_000, env: { EKO_CORE_COVERAGE: '1' }, hookTimeout: 90_000, pool: 'forks' },
    })),
    coverage: {
      provider: 'v8',
      include: coreFiles,
      exclude: ['**/test/**', '**/node_modules/**', 'apps/mcp/src/index.ts', 'apps/indexer/src/index.ts',
        'packages/policy/src/index.ts', 'apps/server/src/exec/types.ts', 'apps/indexer/src/types.ts',
        // Process entry points contain no core decisions; their runtime implementations remain included.
        'apps/mcp/src/cli.ts', 'apps/indexer/src/cli.ts', 'apps/indexer/src/backfill-gate-cli.ts'],
      reportsDirectory: 'coverage/typescript',
      reporter: ['text', 'json-summary', 'lcov'],
      reportOnFailure: true,
      // Do not impose an unmeasured threshold. The report must include every census file.
    },
  },
});
