import { safeError } from './safe-error.js';
import type { Address, Hex } from 'viem';
export interface RpcTransaction { hash: Hex; from: Address; to: Address | null; input?: Hex; gas?: Hex; type?: Hex; transactionIndex?: Hex; authorizationList?: { chainId: Hex; address: Address; nonce: Hex; yParity: Hex; r: Hex; s: Hex }[] }
export interface RpcLog { address: Address; topics: [Hex, ...Hex[]]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed?: boolean; blockTimestamp?: Hex }
export interface RpcReceipt { synthetic?: boolean; gasUsed?: Hex; transactionIndex?: Hex; status?: Hex; transactionHash: Hex; blockHash: Hex; blockNumber: Hex; logs: RpcLog[]; from?: Address; to?: Address | null; type?: Hex }
export interface RpcBlock { number: Hex; hash: Hex; parentHash: Hex; timestamp: Hex; transactions: RpcTransaction[]; transactionsComplete?: boolean }
export interface TokenMetadata { symbol: string | null; name: string | null; decimals: number | null; totalSupply?: bigint | null; supplyBlock?: bigint | null }
export interface EthUsdSource { address: Address; venue: 'uniswap_v3'; fee: number }
export interface EthUsdRate { value: number; block: bigint; source: EthUsdSource }
export interface PoolMetadata { currency0: Address; currency1: Address; fee: number; tickSpacing: number }
export interface ChainClient {
  rpcStopped?(): boolean;
  /** The paid lane's daily budget is spent for today (public-capable reads continue on the public lane). */
  paidExhausted?(): boolean;
  rpcTiming?(): { admissionMs: number; rpcMs: number; rateWaitMs: number; publicRateWaitMs?:number; paidRateWaitMs?:number };
  chainId(): Promise<number>;
  head(): Promise<bigint>;
  block(n: bigint): Promise<RpcBlock>;
  header?(n: bigint): Promise<RpcBlock>;
  timestampHeader?(n: bigint): Promise<RpcBlock>;
  parentHeader?(n: bigint): Promise<RpcBlock>;
  receipts(n: bigint): Promise<RpcReceipt[]>;
  logs(input: { from: bigint; to: bigint; address?: Address; addresses?: Address[]; topics: Hex[]; topicFilters?: (Hex | Hex[] | null)[] }): Promise<RpcLog[]>;
  timestampLogs?(input:{from:bigint;to:bigint;topics:Hex[]}):Promise<RpcLog[]>;
  agentWallets?(ids: bigint[], n: bigint): Promise<{ owner: Address; wallet: Address; tokenUri: string | null }[]>;
  tokenMetadata(address: Address, n: bigint): Promise<TokenMetadata>;
  tokenMetadataBatch?(addresses: Address[], n: bigint): Promise<TokenMetadata[]>;
  ethUsdRate?(n: bigint): Promise<EthUsdRate | null>;
  v3Pool(address: Address, n: bigint): Promise<PoolMetadata | null>;
  /** The canonical v3 factory's pool for a currency pair and fee at a block, or null when it has none. */
  canonicalV3Pool?(token0: Address, token1: Address, fee: number, n: bigint): Promise<Address | null>;
  code(address: Address, n: bigint): Promise<Hex>;
  watch?(onHead: (n: bigint) => void, onError: (error: unknown) => void): () => void;
}
export type Logger = (event: string, fields?: Record<string, unknown>) => void;
export const log: Logger = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));
export const json = (value: unknown): string => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export class Metrics {
  blocks = 0; unknownTopics = 0; malformedLogs = 0; headLagMs = 0; blocksBehind = 0;
  private started = Date.now(); private reported = 0; private headTimestamp: bigint | null = null; private appliedTimestamp: bigint | null = null;
  observeLogs(timestamp: Hex | null, blocksBehind: bigint) {
    this.blocksBehind = Number(blocksBehind);
    if (timestamp != null) this.appliedTimestamp = BigInt(timestamp);
    this.headLagMs = this.appliedTimestamp == null ? 0 : Math.max(0, Date.now() - Number(this.appliedTimestamp) * 1000);
    this.logger('ingest_metrics', { head_lag_ms: this.headLagMs, blocks_behind: this.blocksBehind, blocks: this.blocks, blocks_per_second: this.blocks / Math.max(0.001, (Date.now() - this.started) / 1000), unknown_topics: this.unknownTopics, malformed_logs: this.malformedLogs, log_reasons: { ...this.reasons }, log_topics:{...this.topics} });
  }
  hasHeadMeasurement() { return this.appliedTimestamp !== null; }
  setHead(timestamp: Hex) { this.headTimestamp = BigInt(timestamp); this.updateLag(); }
  private updateLag() { this.headLagMs = this.headTimestamp == null || this.appliedTimestamp == null ? 0 : Math.max(0, Number(this.headTimestamp - this.appliedTimestamp) * 1000); }
  private reasons: Record<string, number> = {};
  private topics:Record<string,number>={};
  classify(reason: string, sample: RpcLog) {
    reason = safeError(reason);
    if (!this.reasons[reason]) this.logger('log_classification_sample', { reason, address: sample.address, topic0: sample.topics[0], topic_count: sample.topics.length, data_length: (sample.data.length - 2) / 2 });
    // Bounded selector counts distinguish intentional omissions from filter mistakes.
    const topic=/^0x[0-9a-f]{64}$/i.test(sample.topics[0])?sample.topics[0].toLowerCase():'invalid';
    const topicKey=`${reason}:${topic}`;
    const bucket=topicKey in this.topics||Object.keys(this.topics).length<64?topicKey:'other';
    this.topics[bucket]=(this.topics[bucket]??0)+1;
    this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
    if (reason === 'malformed') this.malformedLogs++;
    if (reason === 'unknown_topic') this.unknownTopics++;
  }
  constructor(private logger: Logger = log) {}
  observe(timestamp: Hex) {
    this.blocks++; this.appliedTimestamp = BigInt(timestamp); this.updateLag();
    if (Date.now() - this.reported < 1000) return;
    this.reported = Date.now();
    this.logger('ingest_metrics', { head_lag_ms: this.headLagMs, blocks_per_second: this.blocks / Math.max(0.001, (Date.now() - this.started) / 1000), unknown_topics: this.unknownTopics, malformed_logs: this.malformedLogs, log_reasons: { ...this.reasons }, log_topics:{...this.topics} });
  }
}
