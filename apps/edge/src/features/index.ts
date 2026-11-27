import { readdirSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { registerAccountRoutes } from '../accounts.js';
import { FlagNameSchema, type FlagName } from '@eko/shared';
import type { AccountStore } from '../accounts.js';
import type { AlertInbox } from '../alerts.js';
import type { FunderTracer } from '../funders.js';
import type { HistoryStore } from '../history.js';
import type { Edge } from '../service.js';
import type { CoinState, Rpc } from '../tracker.js';

/**
 * Post-launch features, each in its own folder: src/features/<flag>/index.ts, where <flag> is the feature's flag name
 * (packages/shared/src/flags.ts). The edge finds the folders by itself and loads only those whose flag is on
 * (EKO_FLAGS), so adding a feature never edits a shared file, and the public copy can leave a feature's folder out
 * until it is on (scripts/public/publish.mjs, docs/FLAGS.md).
 *
 * A folder's index.ts default-exports a `Feature`: `register` adds its API routes (under /v1 or /v2).
 */
export interface FeatureContext {
  app: FastifyInstance; edge: Edge; store?: HistoryStore; accounts?: AccountStore;
  /** Wallet sign-in, when accounts are open: `need(req, reply)` is the signed-in account, or sends the 401. */
  auth?: ReturnType<typeof registerAccountRoutes>;
  /** In-site alerts for an account (alerts.ts), shown in the alerts drawer. */
  alerts?: AlertInbox;
  /** The chain RPC the edge reads with (paid and metered): a feature that reads the chain keeps it to its own budget. */
  rpc?: Rpc;
  /** The background funder tracer (funders.ts), when the history store is on and the chain has a funding source (an explorer API, or the archive RPC while linked_devs is on): `want(wallets, 'lookup')` queues a page's wallets behind live work. */
  funders?: FunderTracer;
  /** Short figures on each Radar row (RadarRow.extras, under the feature's flag). */
  rows?: RowExtras;
  /** The MCP server (mcp.ts): a feature adds tools for agents, and posts events to the `watch` tool's stream. */
  mcp?: McpPlace;
}
/**
 * What a feature may add to EKO's MCP server while its flag is on (the folder is loaded only then, so with the flag off
 * the tool does not exist). Its figures on Radar rows (RowExtras) reach agents too: in the `coins` tool's rows and in
 * coin_verdict and coin_card, under `extras.<flag>`.
 *
 * `tool` adds a read-only tool that needs no key: a name (lower snake case, not one of EKO's own), a description an agent
 * reads, its JSON input schema, and `run`, which answers with a JSON object or throws an Error whose message the agent
 * sees. Calls are rate limited with every other MCP call. `event` posts to the public `watch` stream (watch.ts) as one of
 * its kinds, for example `dump_risk` or `dev_sell`; the stream adds the time, the coin's symbol, verdict and score.
 */
export interface McpPlace {
  tool(flag: FlagName, tool: FeatureTool): void;
  event(flag: FlagName, e: { kind: 'dev_sell' | 'insider_sell' | 'dump_risk'; coin: string; title: string; data?: Record<string, unknown> }): void;
}
export interface FeatureTool { name: string; description: string; inputSchema: Record<string, unknown>; run(args: Record<string, unknown>): Promise<unknown> }
/**
 * Figures a feature adds to each Radar row, under its flag: `read(coin)` is asked for every row each time the list is
 * built (up to 100 coins, shared by every visitor), so it must be synchronous and cheap: return a figure computed
 * earlier, or undefined for none. A read that throws adds nothing.
 */
export interface RowExtras { add(flag: FlagName, read: (coin: CoinState) => unknown): void }
export interface Feature { register(ctx: FeatureContext): void }
export interface LoadedFeature extends Feature { flag: FlagName }

const HERE = new URL('./', import.meta.url);

/** The feature folders whose flag is on. A folder not named after a flag, or without an index, is skipped. */
export async function loadFeatures(on: ReadonlySet<string>, dir: URL = HERE): Promise<LoadedFeature[]> {
  const out: LoadedFeature[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const flag = FlagNameSchema.safeParse(entry.name);
    if (!entry.isDirectory() || !flag.success || !on.has(flag.data)) continue;
    const mod = await import(new URL(`${entry.name}/index.ts`, dir).href).catch((error: Error) => {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return null; throw error;
    }) as { default?: Feature } | null;
    if (mod?.default) out.push({ flag: flag.data, ...mod.default });
  }
  return out;
}
