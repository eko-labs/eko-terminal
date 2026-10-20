import { withRpcOrigin } from '@eko/chain';
import { createHash } from 'node:crypto';
import { decodeEventLog, encodeFunctionData, formatEther, parseAbi, toEventSelector, toHex, type Hex } from 'viem';
import { binary, hex, type ChainDb } from '@eko/db';
import { z } from 'zod';
import type { Measurement } from './launch.js';
import type { SecurityCollectorsConfig } from './security-config.js';

export const authorityAbi = parseAbi([
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event CommitterChanged(address indexed previous, address indexed next)',
]);
const authorityMetrics = {
  OwnershipTransferStarted: 'registry_ownership_started_timestamp_s',
  OwnershipTransferred: 'registry_ownership_transferred_timestamp_s',
  CommitterChanged: 'registry_committer_changed_timestamp_s',
} as const;
const topics = authorityAbi.map(toEventSelector);
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const committerData = encodeFunctionData({ abi: parseAbi(['function committer() view returns (address)']), functionName: 'committer' });
const zero = `0x${'0'.repeat(40)}`;
const dead = `0x${'0'.repeat(36)}dead`;
const quantity = z.string().regex(/^0x[0-9a-fA-F]+$/).transform(v => BigInt(v));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as Hex);
const headerSchema = z.object({ number: quantity, hash, timestamp: quantity });
const logSchema = z.object({ address: z.string(), blockNumber: quantity, blockHash: hash,
  transactionHash: hash, logIndex: quantity, topics: z.array(hash), data: z.string().regex(/^0x[0-9a-fA-F]*$/), removed: z.boolean().optional() });
type Header = z.infer<typeof headerSchema>;
type Evidence = { block: bigint; log: number; hash: Hex; timestamp: number; data: Record<string, unknown> };
interface Checkpoint { block: string; hash: Uint8Array; log_index: number }
export interface SecurityRpc { request(method: string, params: unknown[]): Promise<unknown> }
export interface SecurityBindings {
  registry: Hex; burn: Hex; published: Hex[]; weth: Hex; usdg: Hex;
}

/** Read-only worker task. The image dispatcher owns its singleton role lease.
 * RPC is supplied only from the application's shared meter, never a raw transport.
 */
export class SecurityCollectors {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private stopped = true;
  /**
   * Wire storage, shared metered RPC, host-approved bindings/configuration and scalar reporting
   * callbacks. No poll starts and no signing occurs; the role dispatcher owns the singleton lease.
   */
  constructor(private db: ChainDb, private rpc: SecurityRpc, private config: SecurityCollectorsConfig,
    private bindings: SecurityBindings, private record: (measurement: Measurement) => Promise<void>,
    private unavailable: (collector: string) => void = () => {},
    private budgetOpen: () => boolean = () => true,
    private unknownTokenObservation: () => void = () => {}) {}
  /**
   * Idempotently start polling and schedule the next poll sixty seconds after completion. Host
   * lifecycle call; uses injected RPC and reporting, with per-collector failure isolation in poll.
   */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const run = () => {
      if (this.stopped) return;
      this.pending = this.poll().finally(() => {
        this.pending = undefined;
        if (!this.stopped) { this.timer = setTimeout(run, 60_000); this.timer.unref(); }
      });
    };
    run();
  }
  /**
   * Stop rescheduling, clear the timer and await the current poll. Host lifecycle call; pending
   * failures propagate.
   */
  async stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.pending; }
  /**
   * Run enabled registry/wallet/reference/gas measurements within the shared budget. Validate
   * canonical evidence and persist bounded checkpoints; isolate each collector failure through
   * unavailable. Never synthesize a successful zero from incomplete history; reporting callback
   * failures follow the same failure path.
   */
  async poll() {
    const tasks: [string, boolean, () => Promise<void>][] = [
      ['registry', !!this.config.registry, () => this.registry()],
      ['wallets', !!this.config.wallets, () => this.wallets()],
      ['wallet_diagnostics', !!this.config.wallets, () => this.walletDiagnostics()],
      ['reference', this.config.reference, () => this.reference()],
      ['gas', this.config.gas, () => this.gas()],
    ];
    // Isolate failures: no raw provider errors, addresses or secrets in logs/metrics.
    for (const [name, enabled, run] of tasks) if (enabled) {
      try { if (!this.budgetOpen()) throw new Error('Budget closed'); await run(); }
      catch { this.unavailable(name); }
    }
  }
  private async chain() { if (quantity.parse(await withRpcOrigin('server.security_collectors.rawL93',()=>this.rpc.request('eth_chainId', []))) !== 4663n) throw new Error('Wrong chain'); }
  private async header(block: bigint | 'latest') {
    const h = headerSchema.parse(await withRpcOrigin('server.security_collectors.rawL95',()=>this.rpc.request('eth_getBlockByNumber', [block === 'latest' ? block : toHex(block), false])));
    if (block !== 'latest' && h.number !== block) throw new Error('Wrong block');
    return h;
  }
  private stream(name: string, input: unknown) { return `security:${name}:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`; }
  private async checkpoint(stream: string): Promise<Checkpoint | undefined> {
    return (await this.db.sql.query<Checkpoint>('SELECT block,hash,log_index FROM security_collector_checkpoints WHERE stream=$1 ORDER BY block DESC LIMIT 1', [stream])).rows[0];
  }
  private async reconcile(stream: string, head: bigint) {
    // One checkpoint per complete bounded window; restart from an earlier canonical
    // window on reorg. Retain older evidence; never cap rollback at a guessed depth.
    let point = await this.checkpoint(stream);
    while (point) {
      const n = BigInt(point.block);
      if (n <= head && (await this.header(n)).hash === hex(point.hash)) break;
      await this.db.tx(async tx => {
        await tx.sql.query('DELETE FROM security_collector_events WHERE stream=$1 AND block >= $2', [stream, point!.block]);
        await tx.sql.query('DELETE FROM security_collector_checkpoints WHERE stream=$1 AND block >= $2', [stream, point!.block]);
      });
      point = await this.checkpoint(stream);
    }
    // Evidence between two checkpoints was committed with the later checkpoint.
    await this.db.sql.query('DELETE FROM security_collector_events WHERE stream=$1 AND block > $2', [stream, point?.block ?? '-1']);
    return point;
  }
  private async save(stream: string, end: Header, evidence: Evidence[], indexed = false) {
    if ((await this.header(end.number)).hash !== end.hash) throw new Error('Reorg during read');
    await this.db.tx(async tx => {
      if (indexed) {
        // Serialize with indexer rollback/replay before accepting receipt evidence.
        await tx.sql.query("SET LOCAL lock_timeout='5s'");
        await tx.sql.query('LOCK TABLE chain_blocks,token_transfers IN SHARE MODE');
        if (await tx.blockHash(end.number) !== end.hash) throw new Error('Indexed head changed');
      }
      for (const e of evidence) {
        if (indexed && await tx.blockHash(e.block) !== e.hash) throw new Error('Indexed block changed');
        await tx.sql.query(`INSERT INTO security_collector_events(stream,block,log_index,hash,timestamp_s,evidence)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(stream,block,log_index) DO UPDATE SET hash=excluded.hash,timestamp_s=excluded.timestamp_s,evidence=excluded.evidence`,
        [stream, e.block.toString(), e.log, binary(e.hash), e.timestamp, JSON.stringify(e.data)]);
      }
      await tx.sql.query(`INSERT INTO security_collector_checkpoints(stream,block,hash,log_index) VALUES($1,$2,$3,$4)
        ON CONFLICT(stream,block) DO UPDATE SET hash=excluded.hash,log_index=excluded.log_index`,
      [stream, end.number.toString(), binary(end.hash), Math.max(-1, ...evidence.filter(e => e.block === end.number).map(e => e.log))]);
    });
  }
  private validRegistry() { if (this.bindings.registry === zero) throw new Error('Registry unconfigured'); }
  private async registry() {
    this.validRegistry(); await this.chain();
    const start = BigInt(this.config.registry!.startBlock);
    const stream = this.stream('registry', [this.bindings.registry, start.toString()]);
    const head = await this.header('latest');
    const point = await this.reconcile(stream, head.number);
    const from = point ? BigInt(point.block) + 1n : start;
    if (head.number < start) throw new Error('Before configured start');
    if (from <= head.number) {
      const to = from + 499n < head.number ? from + 499n : head.number;
      const end = await this.header(to);
      const logs = z.array(logSchema).max(1000).parse(await withRpcOrigin('server.security_collectors.rawL152',()=>this.rpc.request('eth_getLogs', [{
        address: this.bindings.registry, fromBlock: toHex(from), toBlock: toHex(to), topics: [topics],
      }])));
      const evidence: Evidence[] = [];
      const headers = new Map<string, Header>([[to.toString(), end]]);
      for (const log of logs) {
        if (log.address.toLowerCase() !== this.bindings.registry || !topics.includes(log.topics[0])) continue;
        if (log.removed || log.blockNumber < from || log.blockNumber > to || log.logIndex > BigInt(2 ** 31 - 1)) throw new Error('Invalid log');
        const decoded = decodeEventLog({ abi: authorityAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
        if (log.topics.length !== 3 || log.data !== '0x') throw new Error('Malformed authority event');
        let h = headers.get(log.blockNumber.toString());
        if (!h) { h = await this.header(log.blockNumber); headers.set(log.blockNumber.toString(), h); }
        if (h.hash !== log.blockHash) throw new Error('Orphaned log');
        evidence.push({ block: log.blockNumber, log: Number(log.logIndex), hash: h.hash, timestamp: Number(h.timestamp), data: { event: decoded.eventName } });
      }
      await this.save(stream, end, evidence);
      if (to < head.number) return; // Incomplete history cannot assert a successful zero.
    }
    const events = (await this.db.sql.query<{ event: keyof typeof authorityMetrics; timestamp: number }>(
      `SELECT evidence->>'event' AS event,MAX(timestamp_s) AS timestamp FROM security_collector_events WHERE stream=$1 GROUP BY evidence->>'event'`, [stream])).rows;
    for (const [event, metric] of Object.entries(authorityMetrics)) await this.record({ metric, value: Number(events.find(e => e.event === event)?.timestamp ?? 0) });
  }
  private async reference() {
    // The persisted indexer selection binds freshness to the same address, venue and fee. Never use
    // arbitrary reference-looking swaps or ingestion time as source freshness.
    const source = (await this.db.sql.query<{ timestamp: string }>(`SELECT EXTRACT(EPOCH FROM b.ts) AS timestamp
      FROM swaps s JOIN pools p ON p.id=s.pool_id JOIN chain_blocks b ON b.number=s.block
      JOIN (SELECT pool_id,venue,fee FROM eth_usd_reference_sources
        WHERE block <= (SELECT block FROM ingest_cursors WHERE stream='head') ORDER BY block DESC LIMIT 1) selected
        ON selected.pool_id=p.id AND selected.venue=p.venue AND selected.fee=p.fee
      JOIN chain_blocks creation ON creation.number=p.created_block
      WHERE s.venue='uniswap_v3' AND p.venue=s.venue AND p.creation_verified AND p.created_block<=s.block
        AND s.coin=$1 AND s.quote_asset=$2 AND ((p.currency0=$1 AND p.currency1=$2) OR (p.currency0=$2 AND p.currency1=$1))
        AND s.price_quote>0 AND s.price_quote<'Infinity'::double precision
        AND s.block <= (SELECT block FROM ingest_cursors WHERE stream='head')
      ORDER BY s.block DESC,s.log_index DESC LIMIT 1`, [binary(this.bindings.weth), binary(this.bindings.usdg)])).rows[0];
    if (!source) throw new Error('No trusted reference');
    await this.record({ metric: 'reference_price_timestamp_s', value: Number(source.timestamp) });
  }
  private async gas() {
    this.validRegistry(); await this.chain();
    const head = await this.header('latest');
    const pinned = { blockHash: head.hash, requireCanonical: true };
    const result = await withRpcOrigin('server.security_collectors.rawL195',()=>this.rpc.request('eth_call', [{ to: this.bindings.registry, data: committerData }, pinned]));
    if (typeof result !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(result)) throw new Error('Invalid committer');
    const address = `0x${result.slice(-40).toLowerCase()}`;
    if (address === zero) throw new Error('Committer disabled');
    const balance = quantity.parse(await withRpcOrigin('server.security_collectors.rawL199',()=>this.rpc.request('eth_getBalance', [address, pinned])));
    if ((await this.header(head.number)).hash !== head.hash) throw new Error('Reorg during balance read');
    await this.record({ metric: 'receipt_committer_balance_eth', value: Number(formatEther(balance)) });
  }
  private async wallets() {
    const cfg = this.config.wallets!;
    if (this.bindings.burn === zero || !this.bindings.published.length || this.bindings.published.some(a => a === zero)) throw new Error('Wallets unconfigured');
    await this.chain();
    const indexed = await this.db.cursor('head');
    if (indexed === null || indexed < BigInt(cfg.startBlock)) throw new Error('Indexed head unavailable');
    const head = await this.header(indexed);
    if (await this.db.blockHash(indexed) !== head.hash) throw new Error('Orphaned indexed head');
    const stream = this.stream('wallets', [this.bindings, cfg]);
    const point = await this.reconcile(stream, indexed);
    const from = point ? BigInt(point.block) + 1n : BigInt(cfg.startBlock);
    if (from <= indexed) {
      const to = from + 499n < indexed ? from + 499n : indexed;
      const end = await this.header(to);
      // Restrict scope before either quota: arbitrary tokens can emit Transfer
      // observations naming these wallets without authorizing any asset outflow.
      const transfers = (await this.db.sql.query<{ block: string; log_index: number; tx_hash: Uint8Array; token: Uint8Array; from_address: Uint8Array; to_address: Uint8Array; amount: string; hash: Uint8Array; timestamp: string }>(
        `SELECT t.*,b.hash,EXTRACT(EPOCH FROM b.ts) AS timestamp FROM token_transfers t JOIN chain_blocks b ON b.number=t.block
         WHERE t.block BETWEEN $1 AND $2 AND t.kind='Transfer' AND t.amount>0 AND t.from_address=ANY($3::bytea[])
           AND t.token=ANY($4::bytea[])
         ORDER BY t.block,t.log_index LIMIT 1001`, [from.toString(), to.toString(), [...new Set([...this.bindings.published, this.bindings.burn])].map(binary), cfg.assets.map(a => binary(a.token))])).rows;
      if (transfers.length > 1000 || new Set(transfers.map(t => hex(t.tx_hash))).size > 100) throw new Error('Window exceeds receipt budget');
      const receipts = new Map<string, z.infer<typeof receiptSchema>>();
      const evidence: Evidence[] = [];
      const intentAmounts = new Map<string, bigint>();
      for (const t of transfers) {
        const key = `${hex(t.tx_hash)}:${hex(t.token)}:${hex(t.to_address)}`;
        intentAmounts.set(key, (intentAmounts.get(key) ?? 0n) + BigInt(t.amount));
      }
      for (const t of transfers) {
        const token = hex(t.token), fromAddress = hex(t.from_address), toAddress = hex(t.to_address), txHash = hex(t.tx_hash);
        const asset = cfg.assets.find(a => a.token === token);
        if (!asset) throw new Error('Unrecorded asset threshold');
        const metadata = (await this.db.sql.query<{ decimals: number | null }>('SELECT decimals FROM tokens WHERE address=$1', [t.token])).rows[0];
        if (metadata?.decimals !== asset.decimals) throw new Error('Missing or conflicting decimals');
        let receipt = receipts.get(txHash);
        if (!receipt) { receipt = receiptSchema.parse(await withRpcOrigin('server.security_collectors.rawL239',()=>this.rpc.request('eth_getTransactionReceipt', [txHash]))); receipts.set(txHash, receipt); }
        if (receipt.status !== 1n || receipt.transactionHash !== txHash || receipt.blockNumber !== BigInt(t.block) || receipt.blockHash !== hex(t.hash)) throw new Error('Receipt not canonical');
        const log = receipt.logs.find(l => l.logIndex === BigInt(t.log_index));
        if (!log || log.removed || log.blockHash !== receipt.blockHash || log.transactionHash !== txHash || log.blockNumber !== receipt.blockNumber || log.address.toLowerCase() !== token) throw new Error('Transfer log missing');
        const event = decodeEventLog({ abi: transferAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
        if (event.args.from.toLowerCase() !== fromAddress || event.args.to.toLowerCase() !== toAddress || event.args.value !== BigInt(t.amount)) throw new Error('Transfer receipt mismatch');
        const isBurn = fromAddress === this.bindings.burn;
        const intent = cfg.intents.find(i => i.txHash === txHash && i.token === token && i.to === toAddress && intentAmounts.get(`${txHash}:${token}:${toAddress}`)! <= BigInt(i.maxAmountRaw)
          && (i.purpose !== 'burn' || token === cfg.burnToken && [zero, dead].includes(toAddress)));
        evidence.push({ block: BigInt(t.block), log: t.log_index, hash: receipt.blockHash, timestamp: Number(t.timestamp),
          data: { token, amount: t.amount, published: this.bindings.published.includes(fromAddress as Hex), burn: isBurn,
            approved: !!intent, wrong: isBurn && [zero, dead].includes(toAddress) && token !== cfg.burnToken } });
      }
      await this.save(stream, end, evidence, true);
      if (to < indexed) return;
    }
    // TODO(spec): No outflow aggregation window is set; use the five-minute alert
    // window and owner-approved raw per-asset limits, without a fabricated USD rate.
    const rows = (await this.db.sql.query<{ evidence: { token: Hex; amount: string; published: boolean; burn: boolean; approved: boolean; wrong: boolean } }>(
      'SELECT evidence FROM security_collector_events WHERE stream=$1 AND timestamp_s >= $2', [stream, Number(head.timestamp) - 300])).rows;
    let burn = 0, wrong = 0;
    const sums = new Map<string, bigint>();
    for (const { evidence: e } of rows) {
      if (e.wrong) wrong++;
      if (e.burn && !e.approved) burn++;
      if (e.published && !e.approved) sums.set(e.token, (sums.get(e.token) ?? 0n) + BigInt(e.amount));
    }
    const published = cfg.assets.filter(a => (sums.get(a.token) ?? 0n) > BigInt(a.maxOutflowRaw)).length;
    await this.record({ metric: 'published_wallet_unexpected_outflow', value: published });
    await this.record({ metric: 'burn_unexpected_outflow', value: burn });
    await this.record({ metric: 'burn_wrong_token', value: wrong });
  }
  private async walletDiagnostics() {
    const cfg = this.config.wallets!;
    const indexed = await this.db.cursor('head');
    if (indexed === null || indexed < BigInt(cfg.startBlock)) return;
    // TODO(spec): Unknown-token diagnostic retention is unspecified; report only
    // presence in the latest 500 indexed blocks, without receipts or persistence.
    // These untrusted observations never enter alarm evidence or own a cursor.
    // poll isolates diagnostic failures after configured-asset alert processing.
    const from = indexed - 499n > BigInt(cfg.startBlock) ? indexed - 499n : BigInt(cfg.startBlock);
    const observations = (await this.db.sql.query(
      `SELECT 1 FROM token_transfers t WHERE t.block BETWEEN $1 AND $2
         AND t.kind='Transfer' AND t.amount>0 AND t.from_address=ANY($3::bytea[])
         AND NOT (t.token=ANY($4::bytea[])) LIMIT 1`,
      [from.toString(), indexed.toString(), [...new Set([...this.bindings.published, this.bindings.burn])].map(binary), cfg.assets.map(a => binary(a.token))])).rows;
    if (observations.length) this.unknownTokenObservation();
  }
}
const receiptSchema = z.object({ status: quantity, transactionHash: hash, blockHash: hash, blockNumber: quantity, logs: z.array(logSchema).max(10000) });
