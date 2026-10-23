import { BlueChipReader, blueChipConfig } from '../../server/src/read/blue-chip.js';
import pino from 'pino';
import { z } from 'zod';
import { AddressSchema } from '@eko/shared';
import { openDb, type DbHandle } from '../../server/src/db/client.js';
import { HarnessService } from '../../server/src/harness/service.js';
import { EntitlementsService } from '../../server/src/harness/entitlements.js';
import { FileJournalDestructionLedger } from '../../../packages/db/src/crypto/destruction.js';
import { buildMcpApp } from './app.js';
import { SqlRateLimits } from './limits.js';
import { ToolRegistry } from './tools.js';
import { createReceiptReader } from '../../server/src/read/receipt-reader.js';
import { registerReadTools } from './read-tools.js';
import { ReadStore } from '../../server/src/read/store.js';
import { GuardReadStore } from '../../server/src/read/guard-store.js';
import { SensesReadService } from '../../server/src/read/senses.js';
import { ReceiptApiStore, type ReceiptRegistryReader } from '../../../packages/db/src/receipt-api.js';
import { registerHarnessTools } from './harness.js';
import { JournalService } from '../../server/src/harness/journal.js';
import { PreflightService, type CachedPreflightInputs } from '../../server/src/harness/preflight.js';
import { blueChipPreflightInputs } from '../../server/src/harness/preflight-inputs.js';
import { pruneOAuthDiscovery } from './oauth.js';
import { TrustProxyHopsSchema } from '../../server/src/proxy-trust.js';

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(v => v === '' ? undefined : v, schema.optional());
/**
 * Parse the host MCP environment, require key pepper/resource URL and Postgres in production, and
 * reject OAuth activation values. Host configuration only; invalid input throws fixed errors
 * without dumping values.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function mcpConfig(env: NodeJS.ProcessEnv) {
  const parsed = z.object({
    BLUE_CHIP_ENABLED: z.enum(['true','false','1','0']).default('false').transform(v=>v==='true'||v==='1'),
    BLUE_CHIP_MIN_AGE_DAYS: z.coerce.number().nonnegative().default(3),
    BLUE_CHIP_MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(25_000),
    BLUE_CHIP_MIN_HOLDERS: z.coerce.number().int().nonnegative().default(250),
    NODE_ENV: z.enum(['test', 'development', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'), PORT: z.coerce.number().int().min(1).max(65535).default(8710),
    TRUST_PROXY_HOPS: TrustProxyHopsSchema,
    DATABASE_URL: optional(z.url().refine(v => ['postgres:', 'postgresql:'].includes(new URL(v).protocol))),
    RECEIPTS_REGISTRY_ADDRESS: optional(AddressSchema),
    PGLITE_DIR: z.string().default('.data/pglite'), HARNESS_KEY_PEPPER: z.string().min(32),
    JOURNAL_TOMBSTONE_PATH: optional(z.string().min(1)),
    JOURNAL_KEK: optional(z.string().regex(/^[0-9a-fA-F]{64}$/)), JOURNAL_KEK_ID: optional(z.string().min(1)),
    MCP_PUBLIC_URL: z.url(), MCP_OAUTH_ENABLED: z.enum(['false', '0']).default('false'),
    PUBLIC_ORIGIN: z.string().default(''),
    OAUTH_ISSUER: optional(z.url()),
    OAUTH_ACCESS_TTL_S: z.coerce.number().int().min(1).max(3600).default(3600),
    OAUTH_REFRESH_TTL_S: z.coerce.number().int().min(1).max(2592000).default(2592000),
    OAUTH_CODE_TTL_S: z.coerce.number().int().min(1).max(60).default(60),
    OAUTH_REDIRECT_ALLOWLIST: z.string().default('["https://claude.ai/api/mcp/auth_callback"]')
      .transform((value, ctx) => {
        try { return z.array(z.url()).min(1).max(100).parse(JSON.parse(value)); }
        catch { ctx.addIssue({ code: 'custom', message: 'Invalid redirect allowlist' }); return z.NEVER; }
      }),
    LAUNCH_WEEK_AGENT_LIMIT: optional(z.coerce.number().int().nonnegative()),
    FEE_ACTIVE_FROM: optional(z.iso.datetime({ offset: true })), TIERS_ACTIVE_FROM: optional(z.iso.datetime({ offset: true })),
  }).safeParse(env);
  if (!parsed.success) throw new Error('Invalid MCP environment');
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.DATABASE_URL) throw new Error('MCP requires Postgres in production');
  if (!!parsed.data.JOURNAL_KEK !== !!parsed.data.JOURNAL_KEK_ID) throw new Error('Incomplete journal key configuration');
  return parsed.data;
}

/**
 * Construct a logger that redacts authorization and cookie headers. Host wiring only; it is not an
 * authentication check and does not redact arbitrary payloads automatically. Logger construction
 * failures propagate.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export const mcpLogger = (stream?: pino.DestinationStream) => pino({
  level: 'info', base: undefined,
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie'], censor: '[redacted]' },
}, stream);

/** No collectors, simulation/model clients, workers or migrations start here. OAuth stays inactive pending deployed connector acceptance.
 * @remarks
 * Open MCP role storage, wire HMAC/revocation auth, entitlements, limits, read tools and, when
 * encryption/destruction configuration exists, cached preflight and journal tools,
 * verify/prune applied state and schedule cleanup. Host role only; startup errors close storage
 * and reject. Registry reads may use a metered reader; no migrations/chain/model workers run here and
 * OAuth endpoints and token services are omitted.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function createMcpRuntime(env: NodeJS.ProcessEnv, tools: ToolRegistry | undefined = undefined,
  open: typeof openDb = openDb, receiptReader?: ReceiptRegistryReader, cachedInputs?: CachedPreflightInputs) {
  const cfg = mcpConfig(env);
  const handle: DbHandle = await open({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR });
  let prune: NodeJS.Timeout | undefined;
  let receiptVerification: ReturnType<typeof createReceiptReader> | undefined;
  try {
    const destruction = cfg.JOURNAL_TOMBSTONE_PATH ? new FileJournalDestructionLedger(cfg.JOURNAL_TOMBSTONE_PATH) : undefined;
    const auth = new HarnessService(handle.db, cfg.HARNESS_KEY_PEPPER, undefined,
      destruction ? accountId => !!destruction.destroyedAt(accountId) : undefined);
    const entitlements = new EntitlementsService(cfg);
    const limits = new SqlRateLimits(handle.chain.sql, cfg.HARNESS_KEY_PEPPER);
    // Fail startup if the separately applied API migration is absent.
    await limits.prune();
    await pruneOAuthDiscovery(handle.chain);
    // Registry reads reuse metering; no provider calls occur during construction.
    if (!tools && !receiptReader && cfg.RECEIPTS_REGISTRY_ADDRESS) {
      receiptVerification = createReceiptReader({ ...env, RPC_HTTP_URL: env.RPC_HTTP_URL ?? env.RH_MAINNET_RPC_URL }, handle.rpcUsage);
    }
    const unavailableReader = async (): Promise<never> => { throw new Error('Registry verification unavailable'); };
    const receipts = new ReceiptApiStore(handle.chain, cfg.RECEIPTS_REGISTRY_ADDRESS,
      receiptReader ?? receiptVerification?.reader ?? {
        getChainId: unavailableReader, getBlock: unavailableReader, getTransactionReceipt: unavailableReader,
      });
    const legacyReads=new ReadStore(handle.chain);
    legacyReads.blueChip=new BlueChipReader(handle.chain,blueChipConfig(cfg));
    const readTools = tools ?? registerReadTools(new SensesReadService(new GuardReadStore(legacyReads), receipts));
    // Missing encryption/destruction configuration keeps both write tools absent.
    if (destruction && cfg.JOURNAL_KEK && cfg.JOURNAL_KEK_ID) {
      await handle.chain.sql.query('SELECT id FROM preflights LIMIT 0');
      const journal = new JournalService(handle.chain, destruction,
        { kek: Buffer.from(cfg.JOURNAL_KEK, 'hex'), id: cfg.JOURNAL_KEK_ID });
      // Default Senses for preflight: the stored engine verdict/card/price, never acquisition.
      registerHarnessTools(readTools, new PreflightService(handle.chain, journal, cachedInputs ?? blueChipPreflightInputs(blueChipConfig(cfg))), journal);
    }
    const app = buildMcpApp({ authenticate: key => auth.authenticate(key), entitlements: () => entitlements.get(),
      limits, tools: readTools, publicUrl: cfg.MCP_PUBLIC_URL, trustProxyHops: cfg.TRUST_PROXY_HOPS,
      allowedOrigins: cfg.PUBLIC_ORIGIN.split(',').map(v => v.trim()).filter(Boolean),
      close: async () => { if (prune) clearInterval(prune); await receiptVerification?.close(); await handle.close(); },
    }, { loggerInstance: mcpLogger() });
    // Deliberately omit oauth and oauthTokens: Inspector and real-connector
    // acceptance on a deployed origin remain pending. Environment toggles cannot bypass this gate.
    prune = setInterval(() => {
      void Promise.all([limits.prune(), pruneOAuthDiscovery(handle.chain)]).catch(() => app.log.warn('MCP state cleanup unavailable'));
    }, 60_000);
    prune.unref();
    return { app, host: cfg.HOST, port: cfg.PORT };
  } catch (error) { if (prune) clearInterval(prune); await receiptVerification?.close(); await handle.close(); throw error; }
}

/** Signals during startup are remembered; close drains requests and releases the DB.
 * @remarks
 * Start/listen unless a remembered termination signal arrived, wait for termination and drain
 * app/storage with a ten-second force-exit timer. Host lifecycle only; startup/shutdown failure
 * closes resources and throws fixed withheld-detail text.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function runMcpProcess(start = () => createMcpRuntime(process.env), signals: {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
} = process) {
  let stopped = false;
  let runtime: Awaited<ReturnType<typeof createMcpRuntime>> | undefined;
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>(resolve => { resolveStop = resolve; });
  const stop = () => { stopped = true; resolveStop(); };
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  let force: NodeJS.Timeout | undefined;
  try {
    runtime = await start();
    if (!stopped) {
      await runtime.app.listen({ host: runtime.host, port: runtime.port });
      runtime.app.log.info('EKO MCP ready');
    }
    await stopRequested;
    runtime.app.log.info('shutting down MCP');
    force = setTimeout(() => { process.exit(1); }, 10_000); force.unref();
    await runtime.app.close();
  } catch {
    await runtime?.app.close().catch(() => {});
    throw new Error('MCP startup or shutdown failed (details withheld)');
  } finally {
    if (force) clearTimeout(force);
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
  }
}
