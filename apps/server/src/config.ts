import { parseYaml, rpcConfig, type RpcEnv } from '@eko/chain';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { parseSecurityCollectors } from './obs/security-config.js';
import { AddressSchema } from '@eko/shared';
import { parseFlagOverride } from './flags/service.js';
import { parsePointsRates } from './points/config.js';
import { TrustProxyHopsSchema } from './proxy-trust.js';
import { isTreasurySource } from './sanctions/source.js';

// TODO(spec): BACKEND §15.3 leaves WS budgets unspecified; tune these bounded defaults with load evidence.
export const WS_DEFAULT_LIMITS = {
  windowMs: 1000,
  messagesPerWindow: 30,
  hardMessagesPerWindow: 90,
  snapshotsPerConnection: 2,
  snapshotsGlobal: 16,
  snapshotQueue: 128,
};

export const TradeCapsSchema = z.strictObject({
  beta: z.strictObject({ defaultCapUsd: z.strictObject({ team: z.number().positive().max(25), beta_user: z.number().positive().max(100) }) }),
  public: z.array(z.strictObject({ afterHours: z.number().nonnegative(), perTradeUsd: z.number().positive().max(1000) })).min(1)
    .superRefine((steps, ctx) => {
      if (steps[0]?.afterHours !== 0 || steps.some((step, i) => i > 0 && step.afterHours <= steps[i - 1]!.afterHours) || steps.some(step => step.afterHours < 72 && step.perTradeUsd > 250))
        ctx.addIssue({ code: 'custom', message: 'Ordered schedule must start at zero and hold at most $250 for the first 72 hours' });
    }),
  // TODO(spec): Daily caps require an atomic daily spend ledger; refuse non-null until that path exists.
  dailyPerWalletUsd: z.null(),
});
export type TradeCaps = z.infer<typeof TradeCapsSchema>;
export function parseTradeCaps(text: string): TradeCaps { return TradeCapsSchema.parse(parseYaml(text)); }

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const optionalValue = <T extends z.ZodType>(schema: T) => z.preprocess((v) => v === '' ? undefined : v, schema.optional());
// TODO(spec): Deployment addresses are unset locally; zero is an inert placeholder, never a fee target.
const address = z.preprocess((v) => v === '' ? undefined : v, AddressSchema.default('0x0000000000000000000000000000000000000000'));

const EnvSchema = z.object({
  BLUE_CHIP_ENABLED: bool,
  BLUE_CHIP_MIN_AGE_DAYS: z.coerce.number().nonnegative().default(3),
  BLUE_CHIP_MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(25_000),
  BLUE_CHIP_MIN_HOLDERS: z.coerce.number().int().nonnegative().default(250),
  APP_ROLE: z.enum(['api', 'worker', 'dev']).default('api'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  TRUST_PROXY_HOPS: TrustProxyHopsSchema,
  PORT: z.coerce.number().int().default(8710),
  WS_WINDOW_MS: z.coerce.number().int().positive().default(WS_DEFAULT_LIMITS.windowMs),
  WS_MESSAGES_PER_WINDOW: z.coerce.number().int().positive().default(WS_DEFAULT_LIMITS.messagesPerWindow),
  WS_HARD_MESSAGES_PER_WINDOW: z.coerce.number().int().positive().default(WS_DEFAULT_LIMITS.hardMessagesPerWindow),
  WS_SNAPSHOTS_PER_CONNECTION: z.coerce.number().int().positive().default(WS_DEFAULT_LIMITS.snapshotsPerConnection),
  WS_SNAPSHOTS_GLOBAL: z.coerce.number().int().positive().default(WS_DEFAULT_LIMITS.snapshotsGlobal),
  WS_SNAPSHOT_QUEUE: z.coerce.number().int().nonnegative().default(WS_DEFAULT_LIMITS.snapshotQueue),
  /** Origin of the web app (CORS + SIWE domain). Comma-separate multiple origins. */
  PUBLIC_ORIGIN: z.string().default('http://localhost:5180'),
  TELEGRAM_BOT_HANDLE: optionalValue(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/)),
  /** Shared cookie scope for app/api/mcp; inferred from PUBLIC_ORIGIN when unset. */
  SESSION_COOKIE_DOMAIN: optionalValue(z.string().regex(/^\.?[a-zA-Z0-9.-]+$/)),
  /** Unset launch quotas remain unavailable until a launch limit is approved. */
  LAUNCH_WEEK_AGENT_LIMIT: optionalValue(z.coerce.number().int().nonnegative()),
  POINTS_ACTIVE_FROM: optionalValue(z.iso.datetime({ offset: true })),
  POINTS_RATES: z.string().default('{}').transform(parsePointsRates),
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('.data/pglite'),
  SESSION_SECRET: z.string().optional(),
  JOURNAL_KEK: optionalValue(z.string().regex(/^[0-9a-fA-F]{64}$/)),
  JOURNAL_KEK_ID: optionalValue(z.string().min(1)),
  JOURNAL_TOMBSTONE_PATH: optionalValue(z.string().min(1)),
  HARNESS_KEY_PEPPER: optionalValue(z.string().min(32)),
  /** The MCP role's public endpoint, filled into GET /v1/packs templates; unset keeps {{MCP_URL}}. */
  MCP_PUBLIC_URL: optionalValue(z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/mcp' && !url.search && !url.hash && !url.username && !url.password;
  }, 'MCP_PUBLIC_URL must be an HTTPS /mcp URL')),
  FLAGS: z.string().default(''),
  DEMO_SECRET: optionalValue(z.string().min(32)),
  LEGACY_API: z.enum(['true', 'false', '1', '0']).default('true').transform((v) => v === 'true' || v === '1'),
  // TODO(spec): Retained for the §2.4 env table; the removed analyst feed has no consumers.
  LEGACY_SIGNALS: bool,
  TIERS_ACTIVE_FROM: optionalValue(z.iso.datetime({ offset: true })),
  FEE_ACTIVE_FROM: optionalValue(z.iso.datetime({ offset: true })),
  FEE_BPS_DEFAULT: z.coerce.number().int().min(0).max(10_000).default(50),
  TRADE_MAX_USD: optionalValue(z.coerce.number().positive()),
  TRADE_CAPS_FILE: optionalValue(z.string()),
  TRADE_CAPS_FROM: optionalValue(z.iso.datetime({ offset: true })),
  TRADING_ALLOWLIST_ONLY: z.enum(['true', 'false', '1', '0']).default('true').transform(v => v === 'true' || v === '1'),
  BURN_WALLET_ADDRESS: address,
  RECEIPTS_REGISTRY_ADDRESS: address,
  DEV_FEE_WALLET: address,
  MARKET_DATA_SOURCE: z.enum(['onchain', 'demo']).optional(),
  DEMO_SEED: z.coerce.number().int().default(42),
  ENABLE_DEV_ROUTES: bool,
  SERVE_WEB: bool,
  /** Run the order reconciler in this process. Exactly one process should. */
  RUN_WORKER: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  WEB_DIST_DIR: z.string().default('../web/dist'),
  /** Marketing landing build (apps/landing): when set, its document is served at "/" and its files under /site/. */
  LANDING_DIST_DIR: optionalValue(z.string()),
  // Treasury SDN XML (§2.4). The live list published 10/02/2026 parses with sanctions/parser.ts (checked 2026-10-04).
  OFAC_SDN_URL: optionalValue(z.url().refine(value => isTreasurySource(new URL(value)),
    'OFAC source must be a public Treasury HTTPS URL')),
  LOG_LEVEL: z.string().default('info'),
  SENTRY_DSN: z.string().optional(),

  // AI providers — each is enabled only when its key is present.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  XAI_MODEL: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_MODEL: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  /**
   * One OpenAI-compatible gateway key (PPQ.ai by default) serves every provider that has no
   * direct key. `pnpm setup:ai` writes these two values.
   */
  GATEWAY_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().default('https://api.ppq.ai')),
  GATEWAY_API_KEY: z.string().optional(),
  GATEWAY_MODEL_ANTHROPIC: z.string().optional(),
  GATEWAY_MODEL_OPENAI: z.string().optional(),
  GATEWAY_MODEL_GOOGLE: z.string().optional(),
  GATEWAY_MODEL_XAI: z.string().optional(),
  GATEWAY_MODEL_DEEPSEEK: z.string().optional(),
  GATEWAY_MODEL_MISTRAL: z.string().optional(),
  GATEWAY_MODEL_GROQ: z.string().optional(),
  /** Hard ceiling on estimated AI spend per UTC day across all providers. */
  AI_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(0),
  /** Reserved per-bot hourly call cap: parsed and reported, not enforced (no AI bot path calls InferenceBudget.check). */
  AI_MAX_CALLS_PER_BOT_HOUR: z.coerce.number().int().nonnegative().default(12),
  AI_TIMEOUT_MS: z.coerce.number().int().default(25_000),

  // Robinhood Chain
  RPC_HTTP_URL: optionalValue(z.url()),
  RPC_WS_URL: optionalValue(z.url()),
  RPC_PUBLIC_HTTP_URL: optionalValue(z.url()),
  RPC_PAID_MAX_RPM: z.string().optional(),
  RPC_PUBLIC_MAX_RPM: z.string().optional(),
  RPC_PAID_DAILY_BUDGET: z.string().optional(),
  RPC_PAID_DAILY_SOFT_LIMIT: z.string().optional(),
  RPC_PAID_INDEXER_RESERVE: z.string().optional(),
  RPC_SESSION_BUDGET: z.string().optional(),
  RPC_WEIGHTS: z.string().optional(),
  RH_TESTNET_RPC_URL: z.string().optional(),
  RH_MAINNET_RPC_URL: z.string().optional(),
  /** Mainnet execution stays disabled unless this is explicitly true. */
  LIVE_TRADING_ENABLED: bool,
  /** Private simulation host (Anvil forked from an archive upstream) for live-trade probes; one per process. Unset:
   * live quotes refuse. */
  ANVIL_FORK_URL: optionalValue(z.url()),
  ADMIN_WALLETS: z.string().default(''),
  SECURITY_COLLECTORS: z.string().default('{}').transform(parseSecurityCollectors),
  /** Owner-requested determination retention on the worker. Defaults only report, including legacy rules. */
  RETENTION_SETTLE_HOURS: z.coerce.number().int().min(1).max(8760).default(24),
  RETENTION_SWAP_DAYS: z.coerce.number().int().min(1).max(365).default(1),
  RETENTION_TRANSFER_DAYS: z.coerce.number().int().min(1).max(365).default(1),
  FINGERPRINT_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(1),
  READ_LIQUIDITY_PROBE_KEYS: z.coerce.number().int().min(1).max(1000).default(100),
  FINGERPRINT_REFRESH_DAYS: z.coerce.number().int().min(1).max(365).default(1),
  RETENTION_RAW_DAYS: z.coerce.number().int().min(1).max(365).default(1),
  RETENTION_RATING_DAYS: z.coerce.number().int().min(1).max(365).default(1),
  RETENTION_RECEIPT_KEEP_CURRENT: bool,
  RETENTION_RECEIPT_HOURS: z.coerce.number().int().min(1).max(24*365).default(24),
  RETENTION_ENABLED: z.enum(['true','false','1','0']).default('true').transform(v=>v==='true' || v==='1'),
  RETENTION_DRY_RUN: z.enum(['true','false','1','0']).default('true').transform(v=>v==='true' || v==='1'),
  RETENTION_QUOTE_TRANSFER_DAYS: optionalValue(z.coerce.number().int().min(1).max(365)),
  /** Holdings remain available from transfer baselines after compaction. */
  RETENTION_IDLE_TOKEN_DAYS: optionalValue(z.coerce.number().int().min(1).max(365)),
  RETENTION_PENDING_POOL_DAYS: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().int().min(1).max(365).default(1)),
  /** Verdict, playbook and wash rows of the derived Feed projection; their sources are kept (docs/operations/retention.md). */
  RETENTION_FEED_DAYS: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().int().min(1).max(365).default(1)),
  /** Per-coin history: drop raw history of Danger coins with no swap or transfer for this many days, keeping a summary. */
  RETENTION_DANGER_QUIET_DAYS: optionalValue(z.coerce.number().int().min(1).max(365)),
  /** Per-coin history of quiet non-quote coins, with lifetime summaries retained. */
  RETENTION_QUIET_COIN_DAYS: optionalValue(z.coerce.number().int().min(1).max(365)),
  /** Live sell check (BACKEND §6.2). Off unless true: the engines role measures exit cost, and the API re-checks every
   * buy quote and refuses a coin whose sell fails. SELL_CHECK_DAILY_REQUESTS is read by the engines role; it is parsed
   * here too so the build identity attests the cap for every role. */
  SELL_CHECK_ENABLED: bool,
  SELL_CHECK_DAILY_REQUESTS: optionalValue(z.coerce.number().int().min(0).max(5_000_000)),
});

// TODO(spec): BACKEND §2.4/§18 do not define deployment identity. Version 1 attests
// this explicit parsed host-config allowlist; URL/cookie/key/path fields stay excluded.
export const identityConfigKeys = {
  APP_ROLE: true, NODE_ENV: true, TRUST_PROXY_HOPS: true, PORT: true,
  WS_WINDOW_MS: true, WS_MESSAGES_PER_WINDOW: true, WS_HARD_MESSAGES_PER_WINDOW: true,
  WS_SNAPSHOTS_PER_CONNECTION: true, WS_SNAPSHOTS_GLOBAL: true, WS_SNAPSHOT_QUEUE: true,
  LAUNCH_WEEK_AGENT_LIMIT: true, POINTS_ACTIVE_FROM: true, POINTS_RATES: true,
  FLAGS: true, LEGACY_API: true, LEGACY_SIGNALS: true, TIERS_ACTIVE_FROM: true,
  FEE_ACTIVE_FROM: true, FEE_BPS_DEFAULT: true, TRADE_MAX_USD: true, TRADE_CAPS_FROM: true,
  TRADING_ALLOWLIST_ONLY: true, BURN_WALLET_ADDRESS: true, RECEIPTS_REGISTRY_ADDRESS: true,
  MARKET_DATA_SOURCE: true, DEMO_SEED: true, ENABLE_DEV_ROUTES: true, SERVE_WEB: true,
  RUN_WORKER: true, AI_DAILY_BUDGET_USD: true, AI_MAX_CALLS_PER_BOT_HOUR: true,
  AI_TIMEOUT_MS: true, RPC_PAID_MAX_RPM: true, RPC_PUBLIC_MAX_RPM: true,
  RPC_PAID_DAILY_BUDGET: true, RPC_PAID_DAILY_SOFT_LIMIT: true, RPC_PAID_INDEXER_RESERVE: true, RPC_SESSION_BUDGET: true, RPC_WEIGHTS: true,
  LIVE_TRADING_ENABLED: true, SECURITY_COLLECTORS: true, READ_LIQUIDITY_PROBE_KEYS: true,
  RETENTION_SWAP_DAYS: true, RETENTION_TRANSFER_DAYS: true, FINGERPRINT_LOOKBACK_DAYS: true, FINGERPRINT_REFRESH_DAYS: true, RETENTION_SETTLE_HOURS: true, RETENTION_RAW_DAYS: true, RETENTION_RATING_DAYS: true, RETENTION_RECEIPT_HOURS: true, RETENTION_RECEIPT_KEEP_CURRENT: true, RETENTION_DRY_RUN: true, RETENTION_ENABLED: true,
  RETENTION_QUOTE_TRANSFER_DAYS: true, RETENTION_IDLE_TOKEN_DAYS: true, RETENTION_PENDING_POOL_DAYS: true, RETENTION_FEED_DAYS: true,
  RETENTION_DANGER_QUIET_DAYS: true, RETENTION_QUIET_COIN_DAYS: true,
  SELL_CHECK_ENABLED: true, SELL_CHECK_DAILY_REQUESTS: true,
} as const;
// Identity also covers the headless image roles the dispatcher starts (indexer, engines, ...), not only the server's own roles.
const IdentityEnvSchema = EnvSchema.pick(identityConfigKeys).extend({
  BLUE_CHIP_ENABLED: bool,
  BLUE_CHIP_MIN_AGE_DAYS: z.coerce.number().nonnegative().default(3),
  BLUE_CHIP_MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(25_000),
  BLUE_CHIP_MIN_HOLDERS: z.coerce.number().int().nonnegative().default(250),
  APP_ROLE: z.enum(['api', 'worker', 'dev', 'indexer', 'engines', 'mcp', 'receipts', 'bots', 'og']).default('api'),
});

// Parse only allowlisted inputs with the SAME defaults/transforms as runtime boot.
// No secrets, generated dev secret, file paths or I/O are needed by the verifier.
export function parseIdentityConfiguration(env: NodeJS.ProcessEnv, tradeCapsText: string) {
  return normalizeIdentityConfiguration(IdentityEnvSchema.parse(env), parseTradeCaps(tradeCapsText));
}
function normalizeIdentityConfiguration(c: z.infer<typeof IdentityEnvSchema>, tradeCaps: TradeCaps) {
  const rpc = rpcConfig(c);
  const values: Record<string, unknown> = Object.fromEntries(Object.keys(identityConfigKeys).map(key => [key, c[key as keyof typeof c] ?? null]));
  if(c.BLUE_CHIP_ENABLED) { values.BLUE_CHIP_ENABLED=true;values.BLUE_CHIP_MIN_AGE_DAYS=c.BLUE_CHIP_MIN_AGE_DAYS;values.BLUE_CHIP_MIN_LIQUIDITY_USD=c.BLUE_CHIP_MIN_LIQUIDITY_USD;values.BLUE_CHIP_MIN_HOLDERS=c.BLUE_CHIP_MIN_HOLDERS; }
  values.MARKET_DATA_SOURCE = c.MARKET_DATA_SOURCE ?? (c.NODE_ENV === 'production' ? 'onchain' : 'demo');
  values.FLAGS = [...parseFlagOverride(c.FLAGS)].sort();
  values.BURN_WALLET_ADDRESS = c.BURN_WALLET_ADDRESS.toLowerCase();
  values.RECEIPTS_REGISTRY_ADDRESS = c.RECEIPTS_REGISTRY_ADDRESS.toLowerCase();
  values.RPC_PAID_MAX_RPM = rpc.paidRpm;
  values.RPC_PUBLIC_MAX_RPM = rpc.publicRpm;
  values.RPC_PAID_DAILY_BUDGET = rpc.dailyBudget;
  values.RPC_PAID_DAILY_SOFT_LIMIT = rpc.softLimit;
  values.RPC_PAID_INDEXER_RESERVE = rpc.indexerReserve;
  values.RPC_SESSION_BUDGET = Number.isFinite(rpc.sessionBudget) ? rpc.sessionBudget : 'unlimited';
  values.RPC_WEIGHTS = rpc.weights;
  return { environment: values, tradeCaps };
}
export function effectiveIdentityConfiguration(cfg: Config) {
  // Project parsed values, never re-read process.env or spread the Config (which has secrets).
  const selected = Object.fromEntries(Object.keys(identityConfigKeys).map(key => [key, cfg[key as keyof typeof identityConfigKeys]]));
  return normalizeIdentityConfiguration({...selected,BLUE_CHIP_ENABLED:cfg.BLUE_CHIP_ENABLED,BLUE_CHIP_MIN_AGE_DAYS:cfg.BLUE_CHIP_MIN_AGE_DAYS,BLUE_CHIP_MIN_LIQUIDITY_USD:cfg.BLUE_CHIP_MIN_LIQUIDITY_USD,BLUE_CHIP_MIN_HOLDERS:cfg.BLUE_CHIP_MIN_HOLDERS} as z.infer<typeof IdentityEnvSchema>, cfg.tradeCaps);
}

export type Config = Omit<z.infer<typeof EnvSchema>, 'MARKET_DATA_SOURCE'> & {
  MARKET_DATA_SOURCE: 'onchain' | 'demo';
  sessionSecret: string;
  origins: string[];
  adminWallets: Set<string>;
  tradeCaps: TradeCaps;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  const c = { ...parsed.data, MARKET_DATA_SOURCE: parsed.data.MARKET_DATA_SOURCE ?? (parsed.data.NODE_ENV === 'production' ? 'onchain' : 'demo') };
  if (c.WS_HARD_MESSAGES_PER_WINDOW <= c.WS_MESSAGES_PER_WINDOW) throw new Error('WS_HARD_MESSAGES_PER_WINDOW must exceed WS_MESSAGES_PER_WINDOW');
  if (c.APP_ROLE === 'dev' && (c.NODE_ENV === 'production' || c.DATABASE_URL)) throw new Error('APP_ROLE=dev is for local PGlite only');
  if (c.NODE_ENV === 'production' && !c.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required in production; PGlite is for local development and tests');
  if (c.NODE_ENV === 'production' && c.APP_ROLE === 'api' && c.RUN_WORKER) throw new Error('API replicas require RUN_WORKER=false; use APP_ROLE=worker for the reconciler');
  if (c.APP_ROLE === 'worker' && !c.RUN_WORKER) throw new Error('APP_ROLE=worker requires RUN_WORKER=true');
  if(c.FINGERPRINT_LOOKBACK_DAYS+c.FINGERPRINT_REFRESH_DAYS>7)throw new Error('Fingerprint lookback plus refresh must fit the seven-day watcher evidence window');
  if (c.RETENTION_ENABLED && (!c.RETENTION_DRY_RUN || (c.RETENTION_QUOTE_TRANSFER_DAYS ?? c.RETENTION_IDLE_TOKEN_DAYS ?? c.RETENTION_DANGER_QUIET_DAYS ?? c.RETENTION_QUIET_COIN_DAYS) !== undefined) && c.SECURITY_COLLECTORS.wallets)
    throw new Error('Transfer retention cannot run with the wallet outflow collectors, which read transfer history');
  if (c.APP_ROLE === 'dev' && (!c.RPC_HTTP_URL || !c.RPC_WS_URL)) throw new Error('APP_ROLE=dev requires RPC_HTTP_URL and RPC_WS_URL');
  if (c.NODE_ENV === 'production' && (!c.SESSION_SECRET || c.SESSION_SECRET.length < 32)) {
    throw new Error('SESSION_SECRET (≥32 chars) is required in production');
  }
  rpcConfig(c as RpcEnv);
  const origins = c.PUBLIC_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length || origins.some(o => { try { return new URL(o).origin !== o || !/^https?:/.test(o); } catch { return true; } })) {
    throw new Error('PUBLIC_ORIGIN must contain exact HTTP(S) origins');
  }
  const cookieDomain = (c.SESSION_COOKIE_DOMAIN ?? new URL(origins[0]!).hostname.replace(/^(app|api|mcp)\./, '')).replace(/^\./, '').toLowerCase();
  if ((c.NODE_ENV === 'production' || c.SESSION_COOKIE_DOMAIN) && origins.some(o => { const host = new URL(o).hostname; return host !== cookieDomain && !host.endsWith(`.${cookieDomain}`); })) {
    throw new Error('Session cookie domain must contain every PUBLIC_ORIGIN host');
  }
  parseFlagOverride(c.FLAGS); // Reject unknown flags and ops switches before opening the database.
  if (c.NODE_ENV === 'production' && !c.DEMO_SECRET) {
    throw new Error('DEMO_SECRET (≥32 chars) is required in production');
  }
  if (c.NODE_ENV === 'production' && c.ENABLE_DEV_ROUTES) {
    throw new Error('ENABLE_DEV_ROUTES must not be set in production');
  }
  if (c.NODE_ENV === 'production' && c.LIVE_TRADING_ENABLED && /localhost|127\.0\.0\.1/.test(c.PUBLIC_ORIGIN)) {
    throw new Error('PUBLIC_ORIGIN must be the public https origin of the app when LIVE_TRADING_ENABLED=true (it is the Sign-In With Ethereum domain)');
  }
  // Fees and burns go to the public burn wallet only, never the dev wallet (AGENTS rule 4, BACKEND §12.5).
  const ZERO = '0x0000000000000000000000000000000000000000';
  if (c.BURN_WALLET_ADDRESS !== ZERO && c.BURN_WALLET_ADDRESS.toLowerCase() === c.DEV_FEE_WALLET.toLowerCase()) {
    throw new Error('BURN_WALLET_ADDRESS must not be the dev wallet');
  }
  if (c.NODE_ENV === 'production' && c.BURN_WALLET_ADDRESS === ZERO) {
    throw new Error('BURN_WALLET_ADDRESS is required in production');
  }
  return {
    ...c,
    tradeCaps: parseTradeCaps(readFileSync(c.TRADE_CAPS_FILE ?? new URL(import.meta.url.includes('/dist/') ? './trading-caps.yaml' : '../config/trading-caps.yaml', import.meta.url), 'utf8')),
    sessionSecret: c.SESSION_SECRET ?? devSecret(c.PGLITE_DIR),
    origins,
    adminWallets: new Set(
      c.ADMIN_WALLETS.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}

/** Development only: a generated secret persisted next to the local database so sessions survive restarts. */
function devSecret(pgliteDir: string): string {
  const file = join(dirname(pgliteDir === ':memory:' ? '.data/x' : pgliteDir), 'dev-session-secret');
  try {
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    mkdirSync(dirname(file), { recursive: true });
    const s = randomBytes(32).toString('hex');
    writeFileSync(file, s, { mode: 0o600 });
    return s;
  } catch {
    return randomBytes(32).toString('hex');
  }
}
