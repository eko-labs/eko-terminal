import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { binary, tokens as tokenSchema, chainTables, hex, migrate, ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { RpcGuardError, decodeResult, loadRegistry, v3Abi, v4Abi, ponsCurveAbi, wethAbi, erc20Abi, AddressRegistry } from '@eko/chain';
import { encodeAbiParameters, encodeEventTopics, getAddress, toHex, toEventSelector, parseAbi, type AbiEvent, type Address, type Hex } from 'viem';
import { AdaptiveWindow, PonsBackfill, RangeLeases } from '../src/backfill.js';
import { BlockDecoder } from '../src/decode.js';
import { BlockQueue, HeadFollower, ReorgDepthError } from '../src/head.js';
import { lower, native } from '../src/clients.js';
import { Metrics, type ChainClient, type PoolMetadata, type RpcBlock, type RpcLog, type RpcReceipt } from '../src/types.js';
const registry = loadRegistry();
const fixture = JSON.parse(readFileSync(new URL('./fixtures/4663/blocks.json', import.meta.url), 'utf8')) as Record<string, { number: string; block: RpcBlock; receipts: RpcReceipt[] }>;
const handles: ChainDb[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(handles.splice(0).map(db => db.close())); });
const quiet = () => {};
async function database() { const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db); await migrate(db); return db; }
function clientFor(blocks: { block: RpcBlock; receipts: RpcReceipt[] }[]): ChainClient {
  const byNumber = new Map(blocks.map(b => [BigInt(b.block.number), b]));
  // Mock historical contract reads from the captured receipt's pool transfers; no RPC is used.
  const pools = new Map<string, PoolMetadata>();
  for (const b of blocks) for (const r of b.receipts) for (const l of r.logs) {
    for (const e of decodeResult(l, { registry, isV3Pool: () => true }).events) if (e.source === 'uniswap_v3' && e.eventName === 'Swap') {
      const currencies = new Set<Address>();
      for (const t of r.logs) for (const transfer of decodeResult(t, { registry }).events) if (transfer.source === 'erc20' && [transfer.args.from, transfer.args.to].some(a => lower(a) === lower(l.address))) currencies.add(getAddress(t.address));
      const pair = [...currencies].sort((a,b) => lower(a).localeCompare(lower(b)));
      if (pair.length === 2) pools.set(lower(l.address), { currency0: pair[0], currency1: pair[1], fee: 3000, tickSpacing: 60 });
    }
  }
  return {
    chainId: async () => 4663, head: async () => [...byNumber.keys()].reduce((a,b) => a > b ? a : b, 0n),
    block: async n => { const b = byNumber.get(n); if (!b) throw new Error(`Missing fixture ${n}`); return b.block; },
    receipts: async n => byNumber.get(n)!.receipts,
    code: async () => '0x',
    tokenMetadata: async a => ({ symbol: '<raw-symbol>', name: '<raw-name>', decimals: lower(a) === lower(registry.requireAddress('tokens.USDG')) ? 6 : 18 }),
    v3Pool: async a => pools.get(lower(a)) ?? null,
    ethUsdRate: async n => {
      const reference = [...pools].find(([, p]) => [p.currency0, p.currency1].every(a => [registry.requireAddress('tokens.WETH'), registry.requireAddress('tokens.USDG')].some(token => lower(token) === lower(a))));
      return reference ? { value: 2000, block: 0n, source: { address: reference[0] as Address, venue: 'uniswap_v3', fee: reference[1].fee } } : null;
    },
    logs: async ({ from, to, address, topics }) => [...byNumber].filter(([n]) => n >= from && n <= to).flatMap(([,b]) => b.receipts.flatMap(r => r.logs)).filter(l => (!address || lower(address) === lower(l.address)) && topics.includes(l.topics[0])),
  };
}
function follower(db: ChainDb, client: ChainClient, depth = 256) {
  return new HeadFollower(client, db, new BlockDecoder(client, registry, new Metrics(quiet), quiet), { startBlock: 0n, reorgDepth: depth, logger: quiet });
}
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64,'0')}`;
function empty(n: number, id = n, parent = n - 1): { block: RpcBlock; receipts: RpcReceipt[] } {
  return { block: { number: toHex(n), hash: hash(id), parentHash: hash(Math.max(0,parent)), timestamp: '0x6abe6000', transactions: [] }, receipts: [] };
}
function relocated(name: string, n: number, id: number, parent: number) {
  const b = structuredClone(fixture[name]); b.block.number = toHex(n); b.block.hash = hash(id); b.block.parentHash = hash(parent);
  for (const r of b.receipts) { r.blockNumber = toHex(n); r.blockHash = hash(id); for (const l of r.logs) { l.blockNumber = toHex(n); l.blockHash = hash(id); } }
  return b;
}
function eventLog(event: AbiEvent, address: Address, args: Record<string, unknown>, block: RpcBlock, tx: Hex, index: number): RpcLog {
  return { address, topics: encodeEventTopics({ abi: [event], args }) as [Hex,...Hex[]], data: encodeAbiParameters(event.inputs.filter(p => !p.indexed), event.inputs.filter(p => !p.indexed).map(p => args[p.name!])), blockNumber: block.number, blockHash: block.hash, transactionHash: tx, logIndex: toHex(index) };
}
async function counts(db: ChainDb) {
  const result: Record<string, number> = {};
  for (const table of chainTables) result[table] = Number((await db.sql.query<{ n: string }>(`SELECT count(*) n FROM ${table}`)).rows[0].n);
  return result;
}

describe('guard stops', () => {
  it.each(['rpc_session_budget_reached', 'rpc_budget_exhausted'] as const)('stops a head path on %s without retrying a block or header', async reason => {
    const db = await database(), rpc = clientFor([empty(0)]), logger = vi.fn();
    rpc.header = async () => empty(0).block;
    const error = new Error('Pinned read refused', { cause: new RpcGuardError(reason) });
    const decoder = new BlockDecoder(rpc, registry, new Metrics(quiet), quiet);
    const block = vi.spyOn(rpc, 'block');
    if (reason === 'rpc_session_budget_reached') block.mockRejectedValue(error);
    else vi.spyOn(decoder, 'prefetch').mockRejectedValue(error);
    const head = new HeadFollower(rpc, db, decoder, { startBlock: 0n, prefetchBlocks: 1, reorgDepth: 3, logger });
    await expect(head.run()).rejects.toBe(error);
    expect(block).toHaveBeenCalledTimes(1); expect(await db.cursor('head')).toBeNull();
    expect(logger.mock.calls.map(([event]) => event)).not.toContain('block_retry');
    expect(logger.mock.calls.map(([event]) => event)).not.toContain('head_time_error');
  });
  it('ends the loop on a stopped meter even when the in-flight error is not a budget wrapper', async () => {
    const db = await database(), rpc = clientFor([empty(0)]), logger = vi.fn();
    let stopped = false; rpc.rpcStopped = () => stopped;
    rpc.header = async () => empty(0).block;
    const error = new Error('RPC accounting unavailable');
    const decoder = new BlockDecoder(rpc, registry, new Metrics(quiet), quiet);
    vi.spyOn(decoder, 'prefetch').mockImplementation(async () => { stopped = true; throw error; });
    const head = new HeadFollower(rpc, db, decoder, { startBlock: 0n, prefetchBlocks: 1, reorgDepth: 3, logger });
    await expect(head.run()).rejects.toBe(error);
    expect(logger.mock.calls.map(([event]) => event)).not.toContain('block_retry');
  });
  it('does not retry an in-flight failure after the worker has stopped', async () => {
    const db = await database(), rpc = clientFor([empty(0)]), logger = vi.fn();
    rpc.header = async () => empty(0).block;
    const decoder = new BlockDecoder(rpc, registry, new Metrics(quiet), quiet);
    const head = new HeadFollower(rpc, db, decoder, { startBlock: 0n, prefetchBlocks: 1, reorgDepth: 3, logger });
    vi.spyOn(decoder, 'prefetch').mockImplementation(async () => { head.stop(); throw new Error('Transient failure'); });
    const block = vi.spyOn(rpc, 'block');
    await head.run(); expect(block).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls.map(([event]) => event)).not.toContain('block_retry');
  });
});
describe('chain ingestion on PGlite', () => {
  it('replays captured blocks: raw token text, exemptions, Pons sides/actors, v3/v4 pools, prices, no duplicate rows', async () => {
    const db = await database();
    const all = [fixture.v4Initialize, fixture.v3PoolCreated, fixture.ponsLaunch, fixture.ponsSell];
    const notifications = vi.spyOn(ChainDb.prototype, 'notifyMany');
    const client = clientFor(all);
    // These historical pool emitters are already indexed before sender-scoped ingest starts.
    // Model prior canonical PoolCreated verification for the WETH/USDG reference pair.
    const emitters=new Set(all.flatMap(b=>b.receipts.flatMap(r=>r.logs)).flatMap(l=>decodeResult(l,{registry,isV3Pool:()=>true}).events.some(e=>e.source==='uniswap_v3'&&e.eventName==='Swap')?[lower(l.address)]:[]));
    for(const id of emitters){const p=await client.v3Pool(id,0n);if(!p)continue;for(const a of [p.currency0,p.currency1])await db.insert('tokens',{address:binary(a),...await client.tokenMetadata(a,0n),first_block:'0',block:'0'});await db.insert('pools',{id:binary(id),venue:'uniswap_v3',currency0:binary(p.currency0),currency1:binary(p.currency1),fee:p.fee,tick_spacing:p.tickSpacing,created_block:'0',block:'0',creation_verified:[p.currency0,p.currency1].every(a=>[lower(registry.requireAddress('tokens.WETH')),lower(registry.requireAddress('tokens.USDG'))].includes(lower(a)))});}
    const head = follower(db, client);
    for (const b of all) expect(await head.ingest(b.block,b.receipts)).toBe(true);
    const before = await counts(db);
    const messages = () => notifications.mock.calls.flatMap(([batch]) => batch);
    const messageCount = messages().length;
    for (const { ids } of messages()) expect(Object.keys(ids).every(k => ['n','id','txHash','logIndex','token','wallet'].includes(k))).toBe(true);
    for (const b of all) expect(await head.ingest(b.block,b.receipts)).toBe(true);
    expect(await counts(db)).toEqual(before); expect(messages().length).toBe(messageCount);
    expect(before.chain_blocks).toBe(4); expect(before.pons_exemptions).toBe(6);
    const token = (await db.sql.query<{ address: Uint8Array; symbol: string; name: string; deployer: Uint8Array; curve: Uint8Array }>("SELECT * FROM tokens WHERE launchpad='pons'")).rows;
    expect(token).toHaveLength(1); expect(hex(token[0].address)).toBe('0x7d33d051e0311bcdef1063eedf7ba1c83bae0383');
    expect(token[0].symbol).toBe('<raw-symbol>'); expect(token[0].name).toBe('<raw-name>');
    expect(hex(token[0].deployer)).toBe('0xa0585af9521d532168240ea3f84997142958cf6c');
    expect(hex(token[0].curve)).toBe('0xcc5b05dc34afbc38fc343de3d9be82db3a2a42fb');
    const launchRow = (await db.sql.query<{ tx_hash: Uint8Array; data: Record<string, unknown> }>("SELECT tx_hash,data FROM pons_events WHERE kind='launch'")).rows[0];
    const launchTx = fixture.ponsLaunch.block.transactions.find(t => lower(t.hash) === hex(launchRow.tx_hash))!;
    expect(launchRow.data).toMatchObject({ outerFrom: launchTx.from, outerTo: launchTx.to,
      blockHash: fixture.ponsLaunch.block.hash, timestampSec: BigInt(fixture.ponsLaunch.block.timestamp).toString(),
      launchConfigId: '0', pairToken: native });
    const trades = (await db.sql.query<{ side: number; trader: Uint8Array; amount_coin: string; amount_quote: string; price_quote: number; usd: number | null; priced_block: string | null }>("SELECT * FROM swaps WHERE venue='pons_curve' ORDER BY block,log_index")).rows;
    expect(trades).toHaveLength(6); expect(trades.map(t => t.side)).toEqual([1,1,1,1,1,-1]);
    expect(hex(trades[0].trader)).toBe('0x820fab7b0acdaa427425689ea69486813f29e299');
    expect(hex(trades[5].trader)).toBe('0x148067b4ef2a989dba136c291d5ad7bd4b0e91cc');
    expect(trades[0].amount_coin).toBe('16681299385425812115891132'); expect(trades[0].amount_quote).toBe('30000000000000000');
    expect(trades[5].amount_coin).toBe('15202986877773458328820222'); expect(trades[5].amount_quote).toBe('32552326154212591');
    expect(trades[0].price_quote).toBeCloseTo(0.03 / 16681299.385425812, 18);
    const selected = (await client.ethUsdRate!(0n))!.source;
    // A later captured reference tier cannot supersede this fixture's selected archive source.
    const selectedSwapBlocks = all.flatMap(b => b.receipts.flatMap(r => r.logs)).filter(l => lower(l.address) === lower(selected.address) && decodeResult(l, { registry, isV3Pool: () => true }).events.some(e => e.source === 'uniswap_v3' && e.eventName === 'Swap')).map(l => BigInt(l.blockNumber));
    const latestSelectedBlock = selectedSwapBlocks.reduce((a, b) => a > b ? a : b);
    expect(trades[5].usd).toBeGreaterThan(0); expect(BigInt(trades[5].priced_block!)).toBe(latestSelectedBlock);
    expect(trades[0].usd).toBeGreaterThan(0); expect(BigInt(trades[0].priced_block!)).toBeLessThanOrEqual(BigInt(fixture.ponsLaunch.number));
    const pools = (await db.sql.query<{ id: Uint8Array; venue: string; fee: number; tick_spacing: number }>('SELECT * FROM pools')).rows;
    expect(pools.find(p => hex(p.id) === '0xcf10fe91aeef392aad841a359e51b4a56fc737ff')).toMatchObject({ venue: 'uniswap_v3', fee: 10000, tick_spacing: 200 });
    expect(pools.find(p => hex(p.id) === '0xcb9852db10d49c90f1a847a260aa5fb81b169c7063c37d031b4046ca8e72dee2')).toMatchObject({ venue: 'uniswap_v4', fee: 100, tick_spacing: 1 });
    expect(Number((await db.sql.query<{ n: string }>("SELECT count(*) n FROM swaps WHERE venue='uniswap_v3'")).rows[0].n)).toBe(17);
    // USDG quotes are their own USD value, priced at the swap's block.
    const dollars = (await db.sql.query<{ usd: number | null; amount_quote: string; block: string; priced_block: string | null }>(
      'SELECT usd,amount_quote,block::text,priced_block::text FROM swaps WHERE quote_asset=$1', [binary(registry.requireAddress('tokens.USDG'))])).rows;
    expect(dollars.length).toBeGreaterThan(0);
    for (const d of dollars) { expect(d.usd).toBeCloseTo(Number(d.amount_quote) / 1e6, 6); expect(d.priced_block).toBe(d.block); }
    expect(before.liquidity_events).toBeGreaterThanOrEqual(4); expect(before.token_transfers).toBeGreaterThan(0); expect(before.wallets).toBeGreaterThan(0);
  }, 30000);

  it('rolls back every chain table and cursor, invalidates ranges and applies the replacement branch', async () => {
    const db = await database(); const ancestor = empty(0);
    const a1 = relocated('ponsLaunch',1,101,0); const a2 = relocated('ponsSell',2,102,101);
    const b1 = relocated('ponsLaunch',1,201,0); const b2 = relocated('ponsSell',2,202,201);
    const canonical = clientFor([ancestor,b1,b2]); const head = follower(db,canonical);
    await head.ingest(ancestor.block,[]); await head.ingest(a1.block,a1.receipts); await head.ingest(a2.block,a2.receipts);
    const before = await counts(db);
    await db.sql.query("INSERT INTO ingest_ranges(stream,from_block,to_block,status) VALUES('logs:pons_factory',1,2,'done')");
    expect(await head.ingest(b2.block,b2.receipts)).toBe(false);
    expect(await head.rollback(2n)).toBe(1n);
    for (const table of chainTables) expect(Number((await db.sql.query<{ n: string }>(`SELECT count(*) n FROM ${table} WHERE block>0`)).rows[0].n)).toBe(0);
    expect(await db.cursor('head')).toBe(0n);
    expect((await db.sql.query<{ status: string }>('SELECT status FROM ingest_ranges')).rows[0].status).toBe('todo');
    await head.ingest(b1.block,b1.receipts); await head.ingest(b2.block,b2.receipts);
    expect(await counts(db)).toEqual(before); expect(await db.blockHash(2n)).toBe(hash(202));
  }, 30000);

  it('halts with an alert at the depth limit, preserving committed rows', async () => {
    const db = await database(); const events: string[] = [];
    const client = clientFor([empty(0), empty(1,201,0), empty(2,202,201)]);
    const head = follower(db,client,1);
    await head.ingest(empty(0).block,[]); await head.ingest(empty(1,101,0).block,[]); await head.ingest(empty(2,102,101).block,[]);
    const limited = new HeadFollower(client, db, head.decoder, { startBlock: 0n, reorgDepth: 1, logger: event => events.push(event) });
    await expect(limited.rollback(2n)).rejects.toBeInstanceOf(ReorgDepthError);
    expect(events).toContain('alert'); expect(await db.blockHash(2n)).toBe(hash(102)); expect(await db.cursor('head')).toBe(2n);
  });

  it('creates retained UTC days and three future daily partitions, including year rollover; migrations stay separate', async () => {
    const db = await database(); await migrate(db); await db.ensurePartitions(new Date('2026-12-31T23:59:00Z'));
    const names = (await db.sql.query<{ relname: string }>("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid")).rows.map(r => r.relname);
    for (const table of ['swaps','token_transfers']) for (const suffix of ['d2026_12_31','d2027_01_01','d2027_01_02','d2027_01_03']) expect(names).toContain(`${table}_${suffix}`);
    expect((await db.sql.query<{ id: string }>('SELECT id FROM eko_indexer_migrations ORDER BY id')).rows.map(row => row.id)).toEqual(['0101_chain', '0102_market', '0103_range_errors', '0110_rpc_usage', '0111_pending_senders', '0112_pending_pricing', '0115_guard_sources', '0117_pons_progress', '0136_wallet_protocol', '0150_agent_registry', '0180_eth_usd_reference_sources', '0181_transfer_baselines', '0184_sparse_parent_links','0187_drop_holder_transfer_indexes','0188_block_and_pool_lookups','0190_chain_block_time_index', '0195_reference_swaps_unnamed', '0199_swaps_index_diet', '0205_chain_read_indexes', '0206_watcher_read_indexes', '0207_raw_history_indexes', '0208_raw_history_progress', '0209_bar_write_locks', '0210_daily_raw_history','0211_bounded_raw_seals','0222_rpc_read_cache','0224_watcher_evidence']);
    expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename='guard_chain_evidence'")).rows).toHaveLength(1);
    expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('guard_measurement_evidence','guard_verdict_revisions')")).rows).toHaveLength(0);
    expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename='rpc_usage'")).rows).toHaveLength(1);
    expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename='__drizzle_migrations'")).rows).toHaveLength(0);
    expect(tokenSchema.address.mapFromDriverValue(binary('0xAbCd'))).toBe('0xabcd');
  });

  it('refuses another chain and rolls back a block on decode/write failure', async () => {
    const db = await database(); const client = clientFor([empty(0)]); const head = follower(db,client);
    await expect(follower(db,{ ...client, chainId: async () => 1 }).run()).rejects.toThrow('4663');
    vi.spyOn(head.decoder,'write').mockImplementation(async () => { throw new Error('write failed'); });
    await expect(head.ingest(empty(0).block,[])).rejects.toThrow('write failed');
    expect(await db.cursor('head')).toBeNull(); expect(await db.blockHash(0n)).toBeNull();
    const bad = relocated('ponsLaunch',1,1,0); bad.receipts[0].blockHash = hash(99);
    await expect(head.ingest(bad.block,bad.receipts)).rejects.toThrow('Inconsistent');
  });

  it('uses v4 amount signs from the caller perspective and handles Donate/WETH/known-only transfers', async () => {
    const db = await database(); const block = empty(1).block;
    const coin = getAddress(`0x${'1'.repeat(40)}`); const actor = getAddress(`0x${'2'.repeat(40)}`); const router = registry.requireAddress('uniswapV4.universalRouter'); const pool = hash(500); const tx = hash(501);
    await db.insert('tokens',{address:binary(coin),decimals:18,launchpad:'pons',first_block:'0',block:'0'});
    block.transactions = [{ hash: tx, from: actor, to: router }];
    const init = v4Abi.find(a => a.name === 'Initialize')!; const swap = v4Abi.find(a => a.name === 'Swap')!; const donate = v4Abi.find(a => a.name === 'Donate')!;
    const logs = [eventLog(init,registry.requireAddress('uniswapV4.poolManager'), { id:pool,currency0:native,currency1:coin,fee:100,tickSpacing:1,hooks:native,sqrtPriceX96:1n,tick:0 },block,tx,0),
      eventLog(swap,registry.requireAddress('uniswapV4.poolManager'), { id:pool,sender:router,amount0:-1000000000000000000n,amount1:100000000000000000000n,sqrtPriceX96:1n,liquidity:1n,tick:0,fee:100 },block,tx,1),
      eventLog(donate,registry.requireAddress('uniswapV4.poolManager'), { id:pool,sender:router,amount0:1n,amount1:1n },block,tx,2),
      eventLog(erc20Abi[0],coin,{from:native,to:actor,value:100n},block,tx,3),
      eventLog(erc20Abi[0],getAddress(`0x${'8'.repeat(40)}`),{from:native,to:actor,value:100n},block,tx,4),
      eventLog(wethAbi[0],registry.requireAddress('tokens.WETH'),{dst:actor,wad:1n},block,tx,5),
      eventLog(wethAbi[1],registry.requireAddress('tokens.WETH'),{src:actor,wad:1n},block,tx,6)];
    const receipts = [{ transactionHash:tx,blockHash:block.hash,blockNumber:block.number,logs }]; const client = clientFor([{block,receipts}]);
    expect(await follower(db,client).ingest(block,receipts)).toBe(true);
    const row = (await db.sql.query<{ side:number; trader:Uint8Array; price_quote:number; usd:null }>('SELECT * FROM swaps')).rows[0];
    expect((await db.sql.query('SELECT * FROM token_transfers')).rows).toHaveLength(3);
    expect(row.side).toBe(1); expect(hex(row.trader)).toBe(lower(actor)); expect(row.price_quote).toBe(0.01); expect(row.usd).toBeNull();
    expect((await db.sql.query("SELECT * FROM liquidity_events WHERE kind='Donate'")).rows).toHaveLength(1);
  });

  it('keeps unverified UserOps and sponsored delegated calls unattributed until 043 binding', async () => {
    const db=await database(); const block=empty(1).block; const tx=hash(701); const pool=hash(702);
    const entry=getAddress(`0x${'3'.repeat(40)}`), sender=getAddress(`0x${'4'.repeat(40)}`), delegated=getAddress(`0x${'5'.repeat(40)}`), txFrom=getAddress(`0x${'6'.repeat(40)}`), coin=getAddress(`0x${'7'.repeat(40)}`);
    const customRegistry=new AddressRegistry({...registry.data,entryPoints:{...registry.data.entryPoints,v07:{address:entry}}});
    await db.insert('tokens',{address:binary(coin),decimals:18,launchpad:'pons',first_block:'0',block:'0'});
    block.transactions=[{hash:tx,from:txFrom,to:delegated}];
    const aa=parseAbi(['event BeforeExecution()', 'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)']);
    const manager=registry.requireAddress('uniswapV4.poolManager'); const swap=v4Abi.find(a=>a.name==='Swap')!;
    const trade={id:pool,sender:delegated,amount0:-1n,amount1:100n,sqrtPriceX96:1n,liquidity:1n,tick:0,fee:100};
    const logs=[eventLog(v4Abi[0],manager,{id:pool,currency0:native,currency1:coin,fee:100,tickSpacing:1,hooks:native,sqrtPriceX96:1n,tick:0},block,tx,0),
      eventLog(aa[0],entry,{},block,tx,1),eventLog(swap,manager,trade,block,tx,2),
      eventLog(aa[1],entry,{userOpHash:hash(703),sender,paymaster:native,nonce:0n,success:true,actualGasCost:0n,actualGasUsed:0n},block,tx,3),
      eventLog(swap,manager,trade,block,tx,4)];
    const receipts=[{transactionHash:tx,blockHash:block.hash,blockNumber:block.number,logs}];const client=clientFor([{block,receipts}]);client.code=async()=>`0xef0100${'9'.repeat(40)}`;
    const head=new HeadFollower(client,db,new BlockDecoder(client,customRegistry,new Metrics(quiet),quiet),{startBlock:0n,reorgDepth:256,logger:quiet});
    await head.ingest(block,receipts);
    expect((await db.sql.query<{trader:Uint8Array|null}>('SELECT trader FROM swaps ORDER BY log_index')).rows.map(r=>r.trader)).toEqual([null,null]);
    expect((await db.sql.query('SELECT * FROM userops')).rows).toHaveLength(0);
  });
  it('finishes the current head block and closes watchers on graceful shutdown', async () => {
    const db=await database();const client=clientFor([empty(0),empty(1)]);const unwatch=vi.fn();client.watch=onHead=>{onHead(1n);return unwatch;};
    const head=follower(db,client);const original=head.decoder.write.bind(head.decoder);
    vi.spyOn(head.decoder,'write').mockImplementation(async(...args)=>{head.stop();await original(...args);});
    await head.run();expect(await db.cursor('head')).toBe(0n);expect(await db.blockHash(0n)).toBe(hash(0));expect(await db.blockHash(1n)).toBeNull();expect(unwatch).toHaveBeenCalledOnce();
  });
});

describe('backfill and ordered queue', () => {
  it('deduplicates ordered head announcements and resets on rollback', async () => {
    const q = new BlockQueue(10n); q.upTo(12n); q.upTo(11n); q.upTo(12n);
    expect(await q.next()).toBe(10n); expect(await q.next()).toBe(11n); expect(await q.next()).toBe(12n);
    q.reset(11n); expect(await q.next()).toBe(11n); q.stop(); expect(await q.next()).toBeNull();
  });
  it.each(['logs matched by query exceeds limit of 10000','HTTP response body exceeded the size limit','range over 100000 blocks is not supported'])('halves on %s and doubles on success, bounded at one and 20000', message => {
    expect(new AdaptiveWindow(1000000).size).toBeLessThan(100000);
    const window = new AdaptiveWindow(2000); expect(window.failure(new Error(message))).toBe(true); expect(window.size).toBe(1000);
    window.success(); expect(window.size).toBe(2000); for(let i=0;i<10;i++)window.success(); expect(window.size).toBe(20000);
    expect(window.failure(new Error('permission denied'))).toBe(false); const tiny=new AdaptiveWindow(1);expect(tiny.failure(new Error(message))).toBe(false);
  });
  it('claims disjoint ranges, recovers expired leases, and rejects the stale owner', async () => {
    const db = await database(); const leases = new RangeLeases(db); await leases.seed('logs:pons_factory',0n,40000n);
    const [a,b] = await Promise.all([leases.claim('logs:pons_factory','sample-worker-a',0n,40000n),leases.claim('logs:pons_factory','sample-worker-b',0n,40000n)]);
    expect(a!.from_block).not.toBe(b!.from_block);
    await db.sql.query("UPDATE ingest_ranges SET lease_until=now()-interval '1 second' WHERE from_block=$1",[a!.from_block]);
    const recovered = await leases.claim('logs:pons_factory','sample-worker-c',0n,40000n);
    expect(recovered!.from_block).toBe(a!.from_block); expect(recovered!.attempts).toBe(2);
    await expect(leases.finish(db,a!,'done')).rejects.toThrow('lease lost'); await leases.finish(db,recovered!,'done');
    await leases.seed('logs:pons_factory',0n,60000n);
    const ranges = (await db.sql.query<{ from_block:string; to_block:string }>('SELECT * FROM ingest_ranges ORDER BY from_block')).rows;
    expect(ranges.map(r=>[String(r.from_block),String(r.to_block)])).toEqual([['0','19999'],['20000','39999'],['40000','40000'],['40001','60000']]);
  });
  it('treats a zero log blockTimestamp (as the public RPC returns) as missing and stores the real block time', async () => {
    const db=await database(); const all=[fixture.ponsLaunch,fixture.ponsSell]; const client=clientFor(all);
    const from=BigInt(fixture.ponsLaunch.number); const to=BigInt(fixture.ponsSell.number);
    const logs=client.logs; client.logs=async args=>(await logs(args)).map(l=>({...l,blockTimestamp:'0x0' as const}));
    const fill=new PonsBackfill(client,db,new BlockDecoder(client,registry,new Metrics(quiet),quiet),{workers:1,logRange:20,logger:quiet});
    await fill.run('logs:pons_factory',from,to);await fill.run('logs:pons_curves',from,to);
    const rows=(await db.sql.query<{block:string;ts:Date}>("SELECT block,ts FROM swaps WHERE venue='pons_curve' ORDER BY block")).rows;
    expect(rows.length).toBeGreaterThan(0);
    const expected=new Map(all.map(b=>[String(BigInt(b.block.number)),Number(BigInt(b.block.timestamp))]));
    for(const row of rows)expect(row.ts.getTime()/1000).toBe(expected.get(String(row.block)));
  });
  it('runs factory before curves with parallel leases, filters unknown emitters, and replays without duplicates', async () => {
    const db=await database(); const all=[fixture.ponsLaunch,fixture.ponsSell]; const client=clientFor(all);
    const from=BigInt(fixture.ponsLaunch.number); const to=BigInt(fixture.ponsSell.number);
    const logs=client.logs; const calls: {from:bigint;to:bigint}[]=[]; let limited=false;
    client.logs=async args=>{calls.push(args);if(!limited){limited=true;throw new Error('HTTP response body exceeded the size limit');}const found=await logs(args); return found;};
    const fill=new PonsBackfill(client,db,new BlockDecoder(client,registry,new Metrics(quiet),quiet),{workers:2,logRange:20,logger:quiet});
    await expect(fill.run('logs:pons_curves',from,to)).rejects.toThrow('factory');
    await fill.run('logs:pons_factory',from,to);
    expect(calls[0].to-calls[0].from+1n).toBe(20n);expect(calls[1].to-calls[1].from+1n).toBe(10n);
    expect((await db.sql.query("SELECT * FROM tokens WHERE launchpad='pons'")).rows).toHaveLength(1);
    expect((await db.sql.query('SELECT * FROM swaps')).rows).toHaveLength(0);
    // An identical topic at an unknown curve must never become a Pons event.
    const extra=structuredClone(fixture.ponsLaunch.receipts.flatMap(r=>r.logs).find(l=>l.topics[0]===toEventSelector(ponsCurveAbi.find(a=>a.type==='event'&&a.name==='CurveBuy') as AbiEvent))!);extra.address=getAddress(`0x${'9'.repeat(40)}`);
    client.logs=async args=>[...await logs(args),...(args.address?[]:[extra])];
    await fill.run('logs:pons_curves',from,to);
    expect((await db.sql.query("SELECT * FROM swaps WHERE venue='pons_curve'")).rows).toHaveLength(6);
    expect((await db.sql.query('SELECT * FROM pons_exemptions')).rows).toHaveLength(6);
    expect((await db.sql.query('SELECT * FROM token_transfers')).rows).toHaveLength(0);
    expect((await db.sql.query("SELECT total_supply FROM tokens WHERE launchpad='pons'")).rows[0].total_supply).toBeNull();
    const evidence=(await db.sql.query<{kind:string;data:Record<string,unknown>}>("SELECT kind,data FROM pons_events WHERE kind IN ('launch','trade') ORDER BY block,log_index")).rows;
    expect(evidence[0].data.graduationThreshold).toBe('4200000000000000000');
    expect(evidence.filter(e=>e.kind==='trade')).toHaveLength(6);
    expect(evidence[1].data).toMatchObject({amountEth:'30000000000000000',feeEth:'300000000000000',taxEth:'1200000000000000'});
    // Upgrade fixtures shaped like the previous decoder's rows by re-decoding canonical ranges.
    await db.sql.query("UPDATE pons_events SET data=data-'graduationThreshold'-'pairToken'-'taxEth'");
    const before=await counts(db); await db.sql.query("UPDATE ingest_ranges SET status='todo',attempts=0");
    await fill.run('logs:pons_factory',from,to);await fill.run('logs:pons_curves',from,to);expect(await counts(db)).toEqual(before);
    expect((await db.sql.query("SELECT kind,data FROM pons_events WHERE kind IN ('launch','trade') ORDER BY block,log_index")).rows).toEqual(evidence);
    expect((await db.sql.query("SELECT * FROM ingest_ranges WHERE status<>'done'")).rows).toHaveLength(0);
    expect(await db.cursor('head')).toBeNull(); expect(await db.blockHash(from)).toBeNull();
  },30000);
});

for(const failures of [2,5])it(`retries raw block writes atomically after ${failures} serialization conflicts`,async()=>{
 const db=await database(),data=fixture.ponsLaunch,client=clientFor([data]);
 const decoder=new BlockDecoder(client,registry,new Metrics(quiet),quiet),committed=vi.spyOn(decoder,'committed');
 const follower=new HeadFollower(client,db,decoder,{reorgDepth:3,logger:quiet});
 await db.sql.query('CREATE SEQUENCE sample_ingest_attempt');
 await db.sql.query(`CREATE FUNCTION sample_ingest_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF nextval('sample_ingest_attempt')<=${failures} THEN RAISE EXCEPTION 'sample conflict' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
 await db.sql.query('CREATE TRIGGER sample_ingest_conflict BEFORE INSERT OR UPDATE ON ingest_cursors FOR EACH ROW EXECUTE FUNCTION sample_ingest_conflict()');
 const publish=vi.spyOn(db.bus,'publish');
 if(failures===5) {
  await expect(follower.ingest(data.block,data.receipts)).rejects.toMatchObject({code:'40001',name:'TransactionRetryExhaustedError'});
  expect(await db.cursor('head')).toBeNull();expect(committed).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
  expect((await db.sql.query('SELECT 1 FROM tokens')).rows).toHaveLength(0);
 }
 expect(await follower.ingest(data.block,data.receipts)).toBe(true);
 expect(await db.cursor('head')).toBe(BigInt(data.block.number));expect(committed).toHaveBeenCalledOnce();
 expect(publish.mock.calls.filter(([message])=>message.topic==='chain_block')).toHaveLength(1);
 const counts=await db.sql.query('SELECT (SELECT count(*) FROM swaps) AS swaps,(SELECT count(*) FROM token_transfers) AS transfers,(SELECT sum(amount) FROM balances) AS balance');
 await follower.ingest(data.block,data.receipts);
 expect((await db.sql.query('SELECT (SELECT count(*) FROM swaps) AS swaps,(SELECT count(*) FROM token_transfers) AS transfers,(SELECT sum(amount) FROM balances) AS balance')).rows).toEqual(counts.rows);
});
