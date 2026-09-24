import { collectWalletProtocol, type WalletProtocolInput, type ProtocolActor } from './wallet-protocol.js';
import { decodePoolEvents } from './pool-events.js';
import { loadSenderScope, extendSenderScope, needsSender, ponsPool, type SenderScope, type PoolRow } from './sender-scope.js';
import { decodeResult, decodePonsResult, resolveActor, ponsCurveAbi, v3Abi, v4Abi, erc20Abi, type AddressRegistry, type LaunchpadEvent } from '@eko/chain';
import { binary, hex, type ChainDb } from '@eko/db';
import { decodeEventLog, toEventSelector, toHex, type AbiEvent, type Address, type Hex } from 'viem';
import { native, lower } from './clients.js';
import { AsyncCache, settle } from './concurrency.js';
import { priceSampleBlock } from './price.js';
import { liquidityWallet, swapWallet } from './beneficiary.js';
import { BlockRows } from './rows.js';
import { json, Metrics, type ChainClient, type RpcBlock, type RpcReceipt, type RpcLog, type RpcTransaction, type TokenMetadata, type PoolMetadata, type EthUsdRate, type Logger, log } from './types.js';
interface Token extends TokenMetadata { address: Address; curve: Address | null; launchpad: string | null }
interface Pool { id: Hex; venue: string; currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks?: Address; createdBlock?: bigint; creationVerified?:boolean }
export interface Prepared { storedTokens: Set<string>; storedPools: Set<string>; launches: Map<string, Extract<LaunchpadEvent, { kind: 'launch' }>>; tokens: Map<string, Token>; curves: Map<string, Address>; pools: Map<string, Pool>; actors: Map<string, ProtocolActor>; protocolRows: BlockRows; rate: EthUsdRate | null; scope: SenderScope; forceSenders: boolean }
export interface TokenRow { address: Uint8Array; curve: Uint8Array | null; symbol: string | null; name: string | null; decimals: number | null; launchpad: string | null; total_supply?: string | null; supply_block?: string | null }
export interface RemoteInputs { codes: Map<string, Hex>; codeBlocks?: Map<string, bigint>; metadata: Map<string, TokenMetadata>; pools: Map<string, PoolMetadata>; rate: EthUsdRate | null }
const unindexedPonsTopics=new Set(ponsCurveAbi.filter((e):e is AbiEvent=>e.type==='event'&&['FeesSwept','Initialized'].includes(e.name)).map(toEventSelector));
const poolCreatedTopic=toEventSelector(v3Abi[0]),initializeTopic=toEventSelector(v4Abi[0]),transferTopic=toEventSelector(erc20Abi[0]);
const v3PoolTopics = new Set(v3Abi.slice(1).map(toEventSelector));
const dateOf = (b: RpcBlock) => new Date(Number(BigInt(b.timestamp)) * 1000);
const key = (l: RpcLog) => `${lower(l.transactionHash)}:${Number(BigInt(l.logIndex))}`;
const abs = (n: bigint) => n < 0n ? -n : n;
const scaled = (n: bigint, decimals: number) => Number(n) / 10 ** decimals;

export class BlockDecoder {
  /** Store userops, 7702 delegations and wallet-protocol coverage. Off still computes protocol actors for swap attribution. */
  storeWalletProtocol = true;
  constructor(readonly client: ChainClient, readonly registry: AddressRegistry, readonly metrics = new Metrics(), private logger: Logger = log) {}
  /** Each Pons curve's quote asset (its launch's pair token); curves never change pair. */
  private curvePairs = new Map<string, Address>();
  /** Pair tokens whose metadata this process has read (lowercase). */
  private pairMetadataTried = new Set<string>();
  private poolReads = new AsyncCache<string, PoolMetadata | null>(20000);
  private codeReads = new AsyncCache<string, Hex>();
  private headCodeReads = new AsyncCache<string, {code:Hex;block:bigint}>();
  private headCodes = new Map<string, { code: Hex; checked: number; block: bigint }>();
  private prices = new AsyncCache<bigint, EthUsdRate | null>(1024);
  private metadataHints = new Map<string, Token>();
  private scopeIndexes=new WeakMap<SenderScope,{tokens:Map<string,TokenRow>;pools:Map<string,PoolRow>}>();
  private referenceRate: EthUsdRate | null = null;
  invalidate() { this.poolReads.clear(); this.codeReads.clear(); this.headCodeReads.clear(); this.headCodes.clear(); this.prices.clear(); this.metadataHints.clear(); this.referenceRate = null; }
  committed(state: Prepared) {
    this.referenceRate = state.rate;
    for (const token of state.tokens.values()) this.metadataHints.set(lower(token.address), token);
    while (this.metadataHints.size > 20000) this.metadataHints.delete(this.metadataHints.keys().next().value!);
  }
  /** Reuse one window index; per-block preparation visits its emitters/currencies only. */
  scopeForBlock(scope:SenderScope,logs:RpcLog[],pending:Pick<Prepared,'tokens'|'pools'>={tokens:new Map(),pools:new Map()}) {
    let index=this.scopeIndexes.get(scope);
    if(!index){index={tokens:new Map(scope.tokenRows.map(t=>[hex(t.address),t])),pools:new Map(scope.poolRows.map(p=>[hex(p.id),p]))};this.scopeIndexes.set(scope,index);}
    const tokens=new Set<string>([lower(this.registry.requireAddress('tokens.WETH')),lower(this.registry.requireAddress('tokens.USDG'))]);
    const pools=new Set<string>(),curves=new Map<string,Address>();
    for(const l of logs){
      const address=lower(l.address);tokens.add(address);pools.add(address);
      if(l.topics[1]?.length===66)pools.add(lower(l.topics[1]));
      const token=scope.curves.get(address);if(token){tokens.add(lower(token));curves.set(address,token);}
      if(l.topics[0]===poolCreatedTopic||l.topics[0]===initializeTopic)for(const e of decodePoolEvents(l,{registry:this.registry}).events){
        if(e.source==='uniswap_v3'&&e.eventName==='PoolCreated'){pools.add(lower(e.args.pool));tokens.add(lower(e.args.token0));tokens.add(lower(e.args.token1));}
        if(e.source==='uniswap_v4'&&e.eventName==='Initialize'){pools.add(lower(e.args.id));tokens.add(lower(e.args.currency0));tokens.add(lower(e.args.currency1));}
      }
    }
    const poolFacts=new Map<string,PoolMetadata>(),poolRows:PoolRow[]=[],pendingPools=new Map<string,Pool>();
    for(const id of pools){
      const fact=pending.pools.get(id)??scope.pools.get(id);if(fact){poolFacts.set(id,fact);tokens.add(lower(fact.currency0));tokens.add(lower(fact.currency1));}
      const row=index.pools.get(id);if(row)poolRows.push(row);
      const staged=pending.pools.get(id);if(staged)pendingPools.set(id,staged);
    }
    const tokenRows:TokenRow[]=[],pendingTokens=new Map<string,Token>();
    for(const id of tokens){
      const row=index.tokens.get(id);if(row){tokenRows.push(row);if(row.curve)curves.set(hex(row.curve),hex(row.address) as Address);}
      const staged=pending.tokens.get(id);if(staged){pendingTokens.set(id,staged);if(staged.curve)curves.set(lower(staged.curve),staged.address);}
    }
    return {scope:{tokens:new Set([...tokens].filter(t=>scope.tokens.has(t))),curves,pools:poolFacts,tokenRows,poolRows} satisfies SenderScope,
      pending:{tokens:pendingTokens,pools:pendingPools}};
  }
  /** Network enrichment contains no DB state and can run ahead of ordered application. */
  async prefetch(block: RpcBlock, receipts: RpcReceipt[], options: { ponsOnly?: boolean; discoverLaunches?: boolean; head?: boolean; codeCacheSec?: number; knownTokens?: Map<string, TokenMetadata>; discoveredPools?: Map<string, PoolMetadata>; scope?: SenderScope; forceSenders?: boolean } = {}): Promise<RemoteInputs> {
    const n = BigInt(block.number), inputs: RemoteInputs = { codes: new Map(), codeBlocks: new Map(), metadata: new Map(), pools: new Map(), rate: null };
    const logs = receipts.flatMap(r => r.logs);
    const scope=options.scope ? extendSenderScope(options.scope,logs,this.registry) : undefined;
    const txs = new Map(block.transactions.map(t => [lower(t.hash), t]));
    const launchTokens = new Set<Address>();
    for (const l of logs) {
      const tx = txs.get(lower(l.transactionHash)); if (!tx) throw new Error('Receipt transaction missing from block');
      for (const e of decodePonsResult(l, tx, { registry: this.registry, tokenForCurve: () => null }).events) if (e.kind === 'launch' && options.discoverLaunches !== false) launchTokens.add(e.token);
      if (!options.ponsOnly) for (const e of decodePoolEvents(l, { registry: this.registry }).events) if (e.source === 'uniswap_v3' && e.eventName === 'PoolCreated') inputs.pools.set(lower(e.args.pool), { currency0: e.args.token0, currency1: e.args.token1, fee: e.args.fee, tickSpacing: e.args.tickSpacing });
    }
    if(scope && !options.head && !options.ponsOnly) for(const [id,pool] of await this.discoverV3Pools(logs,new Set(scope.pools.keys()),scope)) {inputs.pools.set(id,pool);scope.pools.set(id,pool);}
    const targets = [...new Set(receipts.filter(r => r.logs.some(l=>options.forceSenders || (scope ? needsSender(l,scope,this.registry) : decodePonsResult(l,{from:native,to:null},{registry:this.registry,tokenForCurve:()=>null}).events.length))).flatMap(r => { const tx = txs.get(lower(r.transactionHash))!; return tx.to && lower(tx.to) !== lower(tx.from) ? [tx.to] : []; }))];
    // TODO(spec): Third-party 7702 authorizations are absent from receipts; unobserved changes rely on TTL/Phase C.
    // Receipt type identifies SetCode; re-check its sender and target without block reads.
    if (options.head) for (const receipt of receipts) if (receipt.type != null && BigInt(receipt.type) === 4n) {
      for (const address of [receipt.from, receipt.to]) if (address) {this.headCodes.delete(lower(address));this.headCodeReads.delete(lower(address));}
    }
    const readCode = async (address: Address) => {
      if (!options.head) { inputs.codeBlocks!.set(lower(address),n); return this.codeReads.get(`${lower(address)}:${n}`, () => this.client.code(address, n)); }
      const cached = this.headCodes.get(lower(address));
      const now = Date.now();
      if (cached && now - cached.checked < (options.codeCacheSec ?? 3600) * 1000) { inputs.codeBlocks!.set(lower(address),cached.block); return cached.code; }
      if(cached) this.headCodeReads.delete(lower(address));
      const observation = await this.headCodeReads.get(lower(address),async()=>({code:await this.client.code(address,n),block:n}));
      this.headCodes.set(lower(address), { code:observation.code, checked:now, block:observation.block });
      inputs.codeBlocks!.set(lower(address),observation.block);
      return observation.code;
    };
    const sample = priceSampleBlock(n);
    const codes = settle(targets.map(async address => inputs.codes.set(lower(address), await readCode(address))));
    // Task 025b: Keep the shared archive sample cache so live/backfill USD rows agree.
    const price = logs.length && this.client.ethUsdRate ? this.prices.get(sample, () => this.client.ethUsdRate!(sample)).then(rate => {
      if (rate && (!Number.isFinite(rate.value) || rate.value <= 0 || rate.block > n || rate.source.venue !== 'uniswap_v3' || ![100,500,3000,10000].includes(rate.source.fee) || !/^0x[0-9a-fA-F]{40}$/.test(rate.source.address) || lower(rate.source.address) === native)) throw new Error('Invalid historical ETH/USD sample');
      inputs.rate = rate;
    }) : Promise.resolve();
    const poolAddresses = options.ponsOnly || options.head || scope ? [] : [...new Set(logs.filter(l => v3PoolTopics.has(l.topics[0]) && lower(l.address) !== lower(this.registry.requireAddress('uniswapV4.poolManager'))).map(l => lower(l.address) as Address))];
    await settle([codes, price, settle(poolAddresses.map(async address => {
      if (inputs.pools.has(lower(address))) return;
      const pool = await this.poolReads.get(lower(address), () => this.client.v3Pool(address, n));
      if (pool) inputs.pools.set(lower(address), pool);
    }))]);
    if (options.discoveredPools) for (const l of logs) {
      const id=lower(l.address)===lower(this.registry.requireAddress('uniswapV4.poolManager'))?lower(l.topics[1]??'0x'):lower(l.address);
      const pool = options.discoveredPools.get(id);
      if (pool) inputs.pools.set(id,pool);
    }
    if(scope)for(const l of logs){const id=lower(l.address)===lower(this.registry.requireAddress('uniswapV4.poolManager'))?lower(l.topics[1]??'0x'):lower(l.address);const p=scope.pools.get(id);if(p)inputs.pools.set(id,p);}
    const relevant=(p:PoolMetadata)=>options.forceSenders || [p.currency0,p.currency1].some(a=>launchTokens.has(a)||scope?.tokens.has(lower(a))) || [p.currency0,p.currency1].every(a=>[lower(this.registry.requireAddress('tokens.WETH')),lower(this.registry.requireAddress('tokens.USDG'))].includes(lower(a)));
    const currencies = [...inputs.pools.values()].filter(relevant).flatMap(p => [p.currency0, p.currency1]);
    if (!options.ponsOnly) for (const l of logs) for (const e of decodePoolEvents(l, { registry: this.registry }).events) if (e.source === 'uniswap_v4' && e.eventName === 'Initialize' && relevant({currency0:e.args.currency0,currency1:e.args.currency1,fee:e.args.fee,tickSpacing:e.args.tickSpacing})) currencies.push(e.args.currency0, e.args.currency1);
    // A token-paired curve's trades are priced in its pair token, so the pair's decimals are read like a pool currency's.
    // Pair tokens were never read (no relevant pool names them): 41 of 65 had no decimals on 2026-10-11 and their curves'
    // swaps stayed unpriced. Each is tried once per process; one without decimals stays unknown.
    const pairTokens = [...new Set(logs.map(l => this.curvePairs.get(lower(l.address))).filter((a): a is Address => !!a && a !== native && !this.pairMetadataTried.has(a)))];
    const addresses = [...new Map([...launchTokens, ...currencies, ...pairTokens].filter(a => lower(a) !== native).map(a => [lower(a), a])).values()];
    const hints = new Map(addresses.map(a => {
      const stored = options.knownTokens?.get(lower(a)), cached = this.metadataHints.get(lower(a));
      // Window scope can still contain a placeholder after earlier ordered blocks filled it.
      return [lower(a), stored?.decimals != null ? stored : cached ?? stored] as const;
    }));
    const fresh = addresses.filter(a => (!options.head && launchTokens.has(a)) || hints.get(lower(a))?.decimals == null);
    for (const a of pairTokens) if (fresh.includes(a)) this.pairMetadataTried.add(a);
    const metadata = !fresh.length ? [] : this.client.tokenMetadataBatch ? await this.client.tokenMetadataBatch(fresh, n) : await Promise.all(fresh.map(a => this.client.tokenMetadata(a, n)));
    if (metadata.length !== fresh.length) throw new Error('Incomplete token metadata batch');
    fresh.forEach((a, i) => inputs.metadata.set(lower(a), metadata[i]));
    for (const address of addresses) if (!inputs.metadata.has(lower(address))) inputs.metadata.set(lower(address), hints.get(lower(address))!);
    return inputs;
  }
  async discoverV3Pools(logs: RpcLog[], known: Set<string>, scope?: SenderScope): Promise<Map<string, PoolMetadata>> {
    const discovered = new Map<string, PoolMetadata>();
    const first = new Map<string,RpcLog>();
    for (const l of logs) if (v3PoolTopics.has(l.topics[0]) && !known.has(lower(l.address)) && lower(l.address) !== lower(this.registry.requireAddress('uniswapV4.poolManager')) && !first.has(lower(l.address))) first.set(lower(l.address),l);
    const reference=[lower(this.registry.requireAddress('tokens.WETH')),lower(this.registry.requireAddress('tokens.USDG'))];
    const counterpart=new Map<string,Set<string>>();
    for(const l of logs)if(l.topics[0]===transferTopic)for(const topic of l.topics.slice(1,3)){
      const address=lower(`0x${topic.slice(-40)}`),currencies=counterpart.get(address)??new Set<string>();currencies.add(lower(l.address));counterpart.set(address,currencies);
    }
    const paired=new Set([...counterpart].filter(([,currencies])=>[...currencies].some(a=>scope?.tokens.has(a)) || reference.every(a=>currencies.has(a))).map(([address])=>address));
    await settle([...first.values()].filter(l=>!scope || paired.has(lower(l.address))).map(async l => {
      const pool = await this.poolReads.get(lower(l.address),() => this.client.v3Pool(l.address,BigInt(l.blockNumber)));
      if (pool) discovered.set(lower(l.address),pool);
    }));
    return discovered;
  }
  async loadTokens(db: ChainDb, emitters: string[]): Promise<TokenRow[]> {
    if (!emitters.length) return [];
    const params = [...new Set(emitters)]; const placeholders = params.map((_, i) => `$${i + 1}`).join(',');
    return (await db.sql.query<TokenRow>(`SELECT address,curve,symbol,name,decimals,launchpad,total_supply,supply_block FROM tokens WHERE address IN (${placeholders}) OR curve IN (${placeholders})`, params.map(binary))).rows;
  }
  async prepare(db: ChainDb, block: RpcBlock, receipts: RpcReceipt[], options: { ponsOnly?: boolean; discoverLaunches?: boolean; remote?: RemoteInputs; tokenRows?: TokenRow[]; pending?: Pick<Prepared, 'tokens' | 'pools'>; scope?: SenderScope; poolRows?: PoolRow[]; forceSenders?: boolean; walletProtocol?: WalletProtocolInput } = {}): Promise<Prepared> {
    const n = BigInt(block.number);
    const scope=extendSenderScope(options.scope ?? await loadSenderScope(db),receipts.flatMap(r=>r.logs),this.registry);
    const remote = options.remote ?? await this.prefetch(block, receipts, {...options,scope,knownTokens:new Map(scope.tokenRows.map(t=>[hex(t.address),t]))});
    for(const [id,pool] of remote.pools)scope.pools.set(id,pool);
    const state: Prepared = { storedTokens: new Set(), storedPools: new Set(), launches: new Map(), tokens: new Map(), curves: new Map(), pools: new Map(), actors: new Map(), protocolRows: new BlockRows(), rate: null, scope, forceSenders:options.forceSenders??false };
    const logs = receipts.flatMap(r => r.logs).sort((a, b) => Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    const protocol = await collectWalletProtocol(block,receipts,this.registry,remote,options.walletProtocol);
    if(this.storeWalletProtocol)state.protocolRows=protocol.rows;
    state.actors=protocol.actors;
    if (!logs.length) return state;
    const emitters = [...new Set(logs.map(l => lower(l.address)))];
    const placeholders = (values: string[]) => values.map((_, i) => `$${i + 1}`).join(',') || 'NULL';
    const poolRefs = [...new Set(logs.flatMap(l => [lower(l.address), ...(l.topics[1]?.length === 66 ? [lower(l.topics[1])] : [])]))];
    const tokenRows = options.tokenRows ?? scope.tokenRows;
    for (const row of tokenRows) {
      const token = { ...row, totalSupply: row.total_supply == null ? null : BigInt(row.total_supply), supplyBlock: row.supply_block == null ? null : BigInt(row.supply_block), address: hex(row.address) as Address, curve: row.curve ? hex(row.curve) as Address : null };
      state.tokens.set(lower(token.address), token); state.storedTokens.add(lower(token.address));
      if (token.curve) state.curves.set(lower(token.curve), token.address);
    }
    const poolRows = options.poolRows ? {rows:options.poolRows} : options.scope ? {rows:scope.poolRows} : options.ponsOnly || !poolRefs.length ? { rows: [] } : await db.sql.query<PoolRow>(options.ponsOnly ? 'SELECT * FROM pools WHERE false' : `SELECT * FROM pools WHERE id IN (${placeholders(poolRefs)})`, options.ponsOnly ? [] : poolRefs.map(binary));
    for (const row of poolRows.rows) { state.storedPools.add(hex(row.id)); state.pools.set(hex(row.id), { id: hex(row.id), venue: row.venue, currency0: hex(row.currency0) as Address, currency1: hex(row.currency1) as Address, fee: row.fee, tickSpacing: row.tick_spacing, creationVerified: row.creation_verified && BigInt(row.created_block) <= n, ...(row.hooks ? { hooks: hex(row.hooks) as Address } : {}) }); }
    if (options.pending) {
      for (const [id,pool] of options.pending.pools) {
        state.storedPools.add(id); state.pools.set(id,{ ...pool,createdBlock:undefined });
      }
      for (const [address,token] of options.pending.tokens) {
        state.storedTokens.add(address); state.tokens.set(address,token);
        if (token.curve) state.curves.set(lower(token.curve),token.address);
      }
    }
    const txs = new Map(block.transactions.map(t => [lower(t.hash), t]));
    // Discover launches/pools before transfers and trades in the same transaction (launch logs can come last).
    for (const l of logs) {
      const tx = txs.get(lower(l.transactionHash))!;
      const pons = decodePonsResult(l, tx, { registry: this.registry, tokenForCurve: curve => state.curves.get(lower(curve)) ?? null });
      for (const e of pons.events) if (e.kind === 'launch' && options.discoverLaunches !== false) {
        state.launches.set(lower(e.token), e);
        const metadata = remote.metadata.get(lower(e.token))!;
        state.tokens.set(lower(e.token), { ...metadata, address: e.token, curve: e.curve, launchpad: 'pons' });
        state.curves.set(lower(e.curve), e.token);
      }
      if (options.ponsOnly) continue;
      const decoded = decodePoolEvents(l, { registry: this.registry, isV3Pool: address => state.pools.has(lower(address)) });
      for (const e of decoded.events) {
        if (e.source === 'uniswap_v3' && e.eventName === 'PoolCreated' && (lower(l.address) === lower(this.registry.requireAddress('uniswapV3.factory')) || !state.pools.get(lower(e.args.pool))?.creationVerified)) state.pools.set(lower(e.args.pool), { id: lower(e.args.pool), venue: e.source, currency0: e.args.token0, currency1: e.args.token1, fee: e.args.fee, tickSpacing: e.args.tickSpacing, createdBlock: n,creationVerified:lower(l.address)===lower(this.registry.requireAddress('uniswapV3.factory')) });
        if (e.source === 'uniswap_v4' && e.eventName === 'Initialize') state.pools.set(lower(e.args.id), { id: lower(e.args.id), venue: e.source, currency0: e.args.currency0, currency1: e.args.currency1, fee: e.args.fee, tickSpacing: e.args.tickSpacing, hooks: e.args.hooks, createdBlock: n });
      }
    }
    const discovered=options.remote ? remote.pools : await this.discoverV3Pools(logs,new Set(state.pools.keys()),scope);
    if (!options.ponsOnly) for (const l of logs) if (v3PoolTopics.has(l.topics[0]) && !state.pools.has(lower(l.address)) && lower(l.address) !== lower(this.registry.requireAddress('uniswapV4.poolManager'))) {
      const pool = remote.pools.get(lower(l.address)) ?? discovered.get(lower(l.address));
      if (pool) state.pools.set(lower(l.address), { ...pool, id: lower(l.address), venue: 'uniswap_v3' });
    }
    if (!options.ponsOnly) for (const pool of state.pools.values()) for (const address of [pool.currency0, pool.currency1]) if (lower(address) !== native && !state.tokens.has(lower(address))) {
      const cached = this.metadataHints.get(lower(address));
      if (cached) { state.storedTokens.add(lower(address)); state.tokens.set(lower(address), cached); continue; }
      const row = scope.tokenRows.find(t=>hex(t.address)===lower(address));
      if (row) {state.storedTokens.add(lower(address));state.tokens.set(lower(address),{...row,address,curve:row.curve?hex(row.curve) as Address:null,totalSupply:row.total_supply==null?null:BigInt(row.total_supply),supplyBlock:row.supply_block==null?null:BigInt(row.supply_block)});}
      else state.tokens.set(lower(address), { symbol:null,name:null,decimals:null,...remote.metadata.get(lower(address)),address,curve:null,launchpad:null });
    }
    for (const [address, metadata] of remote.metadata) {
      const token = state.tokens.get(address);
      if (token && (token.decimals == null || token.totalSupply == null && metadata.totalSupply != null)) {
        state.tokens.set(address, { ...token, ...metadata });
        state.storedTokens.delete(address);
      }
    }
    for (const name of ['WETH', 'USDG'] as const) {
      const address = this.registry.requireAddress(`tokens.${name}`);
      if (this.metadataHints.has(lower(address))) state.storedTokens.add(lower(address));
      if (!state.tokens.has(lower(address))) state.tokens.set(lower(address), { address, decimals: this.registry.data.tokens[name].decimals ?? null, symbol: name, name, curve: null, launchpad: null });
    }
    // A Pons curve quotes in its launch's pair token: native ETH, or USDG, a Robinhood stock token or another Pons coin
    // (about one launch in ten). Curve trades were all recorded as ETH quotes, which mispriced 3,475 coins (2026-10-11).
    for (const e of state.launches.values()) this.curvePairs.set(lower(e.curve), lower(e.pairToken ?? native) as Address);
    const unpaired = [...new Set(logs.map(l => lower(l.address)).filter(a => state.curves.has(a) && !this.curvePairs.has(a)))];
    if (unpaired.length) for (const row of (await db.sql.query<{ curve: string | null; pair: string | null }>(
      `SELECT lower(data->>'curve') AS curve,lower(data->>'pairToken') AS pair FROM pons_events WHERE kind='launch' AND token=ANY($1::bytea[])`,
      [unpaired.map(curve => binary(state.curves.get(curve)!))])).rows) if (row.curve) this.curvePairs.set(row.curve, (row.pair ?? native) as Address);
    const pairs = [...new Set(logs.map(l => this.curvePairs.get(lower(l.address))).filter((a): a is Address => !!a && a !== native && !state.tokens.has(a)))];
    if (pairs.length) for (const row of (await db.sql.query<TokenRow>('SELECT * FROM tokens WHERE address=ANY($1::bytea[])', [pairs.map(binary)])).rows) {
      const address = hex(row.address) as Address; state.storedTokens.add(lower(address));
      state.tokens.set(lower(address), { address, decimals: row.decimals, symbol: row.symbol, name: row.name, curve: null, launchpad: row.launchpad });
    }
    // Pair-token metadata read for this block fills a missing token or missing decimals (written with this block's rows).
    for (const address of new Set(logs.map(l => this.curvePairs.get(lower(l.address))).filter((a): a is Address => !!a && a !== native))) {
      const metadata = remote.metadata.get(lower(address));
      if (metadata?.decimals == null) continue;
      const token = state.tokens.get(lower(address));
      if (!token) state.tokens.set(lower(address), { ...metadata, address, curve: null, launchpad: null });
      else if (token.decimals == null) { state.tokens.set(lower(address), { ...token, ...metadata }); state.storedTokens.delete(lower(address)); }
    }
    const weth = this.registry.requireAddress('tokens.WETH'); const usdg = this.registry.requireAddress('tokens.USDG');
    state.rate = remote.rate;
    const selected = remote.rate?.source;
    const sameSource = (rate: EthUsdRate) => selected != null && lower(rate.source.address) === lower(selected.address) && rate.source.venue === selected.venue && rate.source.fee === selected.fee;
    if (!options.ponsOnly && selected) {
      if (this.referenceRate == null || !sameSource(this.referenceRate) || this.referenceRate.block > n) {
        // For v3, creation_verified records a PoolCreated from the registry's canonical factory.
        this.referenceRate = null;
        // The pool row is checked first and its latest swap read backward through swaps(pool_id,block). As one join, a
        // pool that fails the check (no reference pool had creation_verified on 2026-10-13) made the scan walk the pool's
        // whole history to return nothing: 21 head ticks stalled 10 to 40 s in 30 hours, longer as the history grew.
        const last = await db.sql.query<{ price_quote: number; block: string }>(`SELECT x.price_quote,x.block FROM pools p CROSS JOIN LATERAL (
            SELECT y.price_quote,y.block FROM ((SELECT s.price_quote,s.block,s.log_index FROM swaps s WHERE s.pool_id=p.id AND s.venue=$1 AND s.coin=$2 AND s.quote_asset=$3
              AND s.block <= $4 AND s.block >= p.created_block AND s.price_quote>0 AND s.price_quote<'Infinity'::double precision
            ORDER BY s.block DESC,s.log_index DESC LIMIT 1)
            UNION ALL SELECT s.price_quote,s.block,s.log_index FROM reference_price_baselines s WHERE s.pool_id=p.id AND s.coin=$2 AND s.quote_asset=$3 AND s.block<=$4 AND s.block>=p.created_block
            ) y ORDER BY y.block DESC,y.log_index DESC LIMIT 1) x
          WHERE p.id=$5 AND p.venue=$1 AND p.creation_verified AND p.fee=$6
            AND ((p.currency0=$2 AND p.currency1=$3) OR (p.currency0=$3 AND p.currency1=$2))`, ['uniswap_v3', binary(weth), binary(usdg), n.toString(), binary(selected.address), selected.fee]);
        if (last.rows[0]) this.referenceRate = { value: last.rows[0].price_quote, block: BigInt(last.rows[0].block), source: selected };
      }
      if (this.referenceRate && sameSource(this.referenceRate) && this.referenceRate.block <= n && (!state.rate || this.referenceRate.block >= state.rate.block)) state.rate = this.referenceRate;
    }
    // TODO(spec): §2.1/§4.2a/§4.4 define the canonical v3 source but no expiry; retain the last trusted rate and its block, or null if none exists.
    // The latest reference swap at or before this block also prices earlier trades within the block.
    if (!options.ponsOnly) for (const l of logs) {
      const pool = state.pools.get(lower(l.address));
      if (!selected || !pool || lower(pool.id) !== lower(selected.address) || pool.fee !== selected.fee || pool.venue !== selected.venue || !pool.creationVerified || pool.venue !== 'uniswap_v3' || ![pool.currency0, pool.currency1].some(a => lower(a) === lower(weth)) || ![pool.currency0, pool.currency1].some(a => lower(a) === lower(usdg))) continue;
      for (const e of decodePoolEvents(l, { registry: this.registry, isV3Pool: () => true }).events) if (e.source === 'uniswap_v3' && e.eventName === 'Swap') {
        const weth0 = lower(pool.currency0) === lower(weth);
        const ethAmount = scaled(abs(weth0 ? e.args.amount0 : e.args.amount1), this.registry.data.tokens.WETH.decimals!);
        const usdAmount = scaled(abs(weth0 ? e.args.amount1 : e.args.amount0), this.registry.data.tokens.USDG.decimals!);
        const value = usdAmount / ethAmount;
        if (ethAmount > 0 && Number.isFinite(value) && value > 0) state.rate = { value, block: n, source: selected };
      }
    }
    return state;
  }
  /**
   * `transfers`: the receipts carry every Transfer log of the indexed tokens in each transaction (the head followers'
   * do; a backfill stream reads one kind of log at a time). Only then can a transaction's own logs name the wallet
   * behind a swap or liquidity event outside the sender scope; without it those rows stay senders_pending.
   */
  collect(block: RpcBlock, receipts: RpcReceipt[], state: Prepared, options: { ponsOnly?: boolean; transfers?: boolean; classify?:(reason:string,log:RpcLog)=>void } = {}) {
    const classify=options.classify ?? ((reason:string,log:RpcLog)=>this.metrics.classify(reason,log));
    const rows = new BlockRows();
    rows.merge(state.protocolRows);
    const n = BigInt(block.number); const ts = dateOf(block);
    // Persist the chosen identity with canonical pricing evidence for the worker's freshness query.
    if (state.rate) rows.add('eth_usd_reference_sources', { block: state.rate.block.toString(), pool_id: binary(state.rate.source.address), venue: state.rate.source.venue, fee: state.rate.source.fee });
    for (const token of state.tokens.values()) {
      const launch = state.launches.get(lower(token.address));
      const selectedLaunch = launch && receipts.some(r => r.logs.some(l => lower(l.address) === lower(this.registry.requireAddress('pons.factory')) && lower(l.topics[1]?.slice(-40) ?? '') === lower(token.address).slice(2)));
      if (options.ponsOnly && !selectedLaunch) continue;
      if (state.storedTokens.has(lower(token.address)) && !selectedLaunch) continue;
      rows.add('tokens', { address: binary(token.address), symbol: token.symbol, name: token.name, decimals: token.decimals, total_supply: token.totalSupply?.toString() ?? null, supply_block: token.totalSupply == null ? null : (token.supplyBlock ?? n).toString(), curve: token.curve ? binary(token.curve) : null, launchpad: token.launchpad, deployer: launch?.kind === 'launch' ? binary(launch.deployer) : null, first_block: n.toString(), block: n.toString() });
      if (selectedLaunch) rows.launch(token.address, launch.curve, launch.deployer, n);
    }
    if (!options.ponsOnly) for (const pool of state.pools.values()) {
      if (state.storedPools.has(lower(pool.id)) && pool.createdBlock == null) continue;
      // Reads provide provisional creation blocks; Phase B replaces them with the event block.
      rows.add('pools', { id: binary(pool.id), venue: pool.venue, currency0: binary(pool.currency0), currency1: binary(pool.currency1), fee: pool.fee, tick_spacing: pool.tickSpacing, hooks: pool.hooks ? binary(pool.hooks) : null, creation_verified: pool.creationVerified ?? pool.createdBlock != null, created_block: (pool.createdBlock ?? n).toString(), block: (pool.createdBlock ?? n).toString() });
    }
    if (!options.ponsOnly) for (const pool of state.pools.values()) if (pool.createdBlock != null && pool.hooks && lower(pool.hooks) === lower(this.registry.requireAddress('pons.v4Hook'))) {
      for (const address of [pool.currency0,pool.currency1]) if (![native, lower(this.registry.requireAddress('tokens.WETH')), lower(this.registry.requireAddress('tokens.USDG'))].includes(lower(address))) rows.graduation(address, pool.id, pool.createdBlock);
    }
    const txs = new Map(block.transactions.map(t => [lower(t.hash), t]));
    // A transaction's own logs name the wallet behind its swaps and liquidity events in pools outside the sender scope.
    const txLogs = new Map<string, RpcLog[]>();
    for (const r of receipts) txLogs.set(lower(r.transactionHash), [...(txLogs.get(lower(r.transactionHash)) ?? []), ...r.logs]);
    const poolManager = lower(this.registry.requireAddress('uniswapV4.poolManager'));
    const knownPool = (address: string) => state.pools.has(address) || state.scope.pools.has(address);
    const reference = new Set([native, lower(this.registry.requireAddress('tokens.WETH')), lower(this.registry.requireAddress('tokens.USDG'))]);
    for (const l of receipts.flatMap(r => r.logs).sort((a,b) => Number(BigInt(a.logIndex) - BigInt(b.logIndex)))) {
      const tx = txs.get(lower(l.transactionHash))!;
      const ctx = state.actors.get(key(l)) ?? {};
      const actor = ctx.missing ? null : resolveActor(tx, ctx);
      const base = { block: n.toString(), tx_hash: binary(l.transactionHash), log_index: Number(BigInt(l.logIndex)) };
      const deferredPool=v3PoolTopics.has(l.topics[0]) && lower(l.address)!==lower(this.registry.requireAddress('uniswapV4.poolManager')) && !state.pools.has(lower(l.address));
      if(deferredPool){
        // The transaction's own logs: every log of the batch was filtered for each such event before.
        const hints=(txLogs.get(lower(l.transactionHash)) ?? []).filter(t=>t.topics[0]===transferTopic&&t.topics.slice(1,3).some(a=>lower(`0x${a.slice(-40)}`)===lower(l.address))).map(t=>lower(t.address));
        const {currencyHints:storedHints,...rawLog}=l as RpcLog&{currencyHints?:string[]};
        rows.add('pending_pool_events',{...base,emitter:binary(l.address),currency_hints:json(storedHints??[...new Set(hints)]),data:json({...rawLog,blockTimestamp:toHex(BigInt(block.timestamp))})});
      }

      const pons = decodePonsResult(l, tx, { registry: this.registry, tokenForCurve: c => state.curves.get(lower(c)) ?? null, ...ctx });
      const standard = options.ponsOnly ? { events: [], unknownTopics: 0, malformedLogs: 0 } : decodePoolEvents(l, { registry: this.registry, tx, ...ctx, isV3Pool: a => state.pools.get(lower(a))?.venue === 'uniswap_v3' });
      if (pons.malformedLogs || standard.malformedLogs) classify('malformed', l);
      else if (!pons.events.length && !standard.events.length) {
        let reason=deferredPool?'deferred_pool':l.topics[0] === transferTopic && l.topics.length === 4 && l.data === '0x' ? 'not_erc20' : 'unknown_topic';
        if(state.curves.has(lower(l.address))&&unindexedPonsTopics.has(l.topics[0])){
          try{decodeEventLog({abi:ponsCurveAbi,topics:l.topics,data:l.data,strict:true});reason='unindexed_pons_event';}
          catch{reason='malformed';}
        }
        classify(reason,l);
      }
      for (const e of pons.events) {
        // Preserve the outer transaction separately from resolveActor/UserOp attribution.
        // This is existing receipt/block data, not an additional RPC read.
        rows.add('pons_events', { ...base, token: binary(e.token), emitter: binary(l.address), kind: e.kind, data: json({ ...e, ...(e.kind === 'trade' ? {actor,actorStatus:actor == null ? 'missing_043' : 'resolved'} : {}),
          outerFrom: tx.from, outerTo: tx.to, blockHash: block.hash, timestampSec: BigInt(block.timestamp).toString(),
        }) });
        if (e.kind === 'exempt') rows.add('pons_exemptions', { ...base, token: binary(e.token), wallet: binary(e.wallet) });
        if (e.kind === 'trade') this.swap(rows, state, base, ts, tx, actor, { pool: lower(l.address), venue: 'pons_curve', coin: e.token, quote: this.curvePairs.get(lower(l.address)) ?? native, side: e.side, amountCoin: e.amountToken, amountQuote: e.amountEth, recipient: e.recipient });
        for (const wallet of [actor, ...(e.kind === 'launch' ? [e.deployer] : e.kind === 'exempt' ? [e.wallet] : [])]) if(wallet) rows.add('wallets', { address: binary(wallet), block: n.toString() });
      }
      for (const e of standard.events) {
        if ((e.source === 'uniswap_v3' || e.source === 'uniswap_v4') && e.eventName === 'Swap') {
          const id = e.source === 'uniswap_v4' ? lower(e.args.id) : lower(l.address);
          const pool = state.pools.get(id);
          // Pools outside the discovered history window remain unresolved.
          if (!pool) { this.logger('unknown_pool', { pool: id, block: n.toString() }); continue; }
          const quoteRank = (a: Address) => lower(a) === native ? 3 : lower(a) === lower(this.registry.requireAddress('tokens.WETH')) ? 2 : lower(a) === lower(this.registry.requireAddress('tokens.USDG')) ? 1 : 0;
          const weth = lower(this.registry.requireAddress('tokens.WETH'));
          const usdg = lower(this.registry.requireAddress('tokens.USDG'));
          const referencePair = [pool.currency0, pool.currency1].some(a => lower(a) === weth) && [pool.currency0, pool.currency1].some(a => lower(a) === usdg);
          const coin0 = referencePair ? lower(pool.currency0) === weth : quoteRank(pool.currency1) >= quoteRank(pool.currency0);
          const coinAmount = coin0 ? e.args.amount0 : e.args.amount1; const quoteAmount = coin0 ? e.args.amount1 : e.args.amount0;
          if (coinAmount === 0n || quoteAmount === 0n) continue;
          const bought = e.source === 'uniswap_v3' ? coinAmount < 0n : coinAmount > 0n;
          this.swap(rows, state, base, ts, tx, actor, { pool: id, venue: e.source, coin: coin0 ? pool.currency0 : pool.currency1, quote: coin0 ? pool.currency1 : pool.currency0, side: bought ? 1 : -1, amountCoin: abs(coinAmount), amountQuote: abs(quoteAmount), ...(e.source === 'uniswap_v3' ? { recipient: e.args.recipient } : {}) },
            options.transfers ? { logs: txLogs.get(lower(l.transactionHash)) ?? [], poolManager, knownPool } : undefined);
        } else if ((e.source === 'uniswap_v3' || e.source === 'uniswap_v4') && e.eventName !== 'PoolCreated') {
          const id = e.source === 'uniswap_v4' ? lower(e.args.id) : lower(l.address);
          const scoped = state.forceSenders || ponsPool(state.scope, id);
          // Outside the sender scope the transaction's sender is not read: the wallet whose coins went into or came out of
          // the pool in this transaction, else the owner or sender the event names, else the pool manager or pool.
          let provider: Address | null = null;
          if (!scoped && options.transfers) {
            const args = e.args as { owner?: Address; sender?: Address; liquidityDelta?: bigint }, pool = state.pools.get(id);
            const way = e.eventName === 'Mint' || (e.eventName === 'ModifyLiquidity' && (args.liquidityDelta ?? 0n) > 0n) ? -1 : e.eventName === 'Burn' || (e.eventName === 'ModifyLiquidity' && (args.liquidityDelta ?? 0n) < 0n) ? 1 : 0;
            const coins = pool ? [pool.currency0, pool.currency1].map(lower).filter(a => !reference.has(a)) : [];
            const paid = way ? liquidityWallet(txLogs.get(lower(l.transactionHash)) ?? [], l.transactionHash, coins, id, poolManager, way, knownPool) : null;
            provider = paid ?? args.owner ?? args.sender ?? (e.source === 'uniswap_v4' ? poolManager as Address : id as Address);
            if (paid) rows.add('wallets', { address: binary(paid), block: n.toString() });
          }
          rows.add('liquidity_events', { ...base, ts, venue: e.source, pool_id: binary(id), kind: e.eventName, actor: scoped ? (actor ? binary(actor) : null) : provider ? binary(provider) : null, tx_from:scoped ? binary(tx.from):null, tx_to:scoped ? binary(tx.to??native):null,senders_pending:!scoped && !provider, data: json(e.args) });
        } else if (e.source === 'erc20' && state.tokens.has(lower(l.address))) {
          rows.add('token_transfers', { ...base, ts, token: binary(l.address), from_address: binary(e.args.from), to_address: binary(e.args.to), amount: e.args.value.toString() });
          for (const wallet of [e.args.from, e.args.to]) if(wallet) rows.add('wallets', { address: binary(wallet), block: n.toString() });
        } else if (e.source === 'weth') {
          const deposit = e.eventName === 'Deposit';
          rows.add('token_transfers', { ...base, ts, token: binary(l.address), from_address: binary(deposit ? native : e.args.src), to_address: binary(deposit ? e.args.dst : native), amount: e.args.wad.toString(), kind: e.eventName });
        }
      }
    }
    return rows;
  }
  async write(db: ChainDb, block: RpcBlock, receipts: RpcReceipt[], state: Prepared, options: { ponsOnly?: boolean; transfers?: boolean } = {}) {
    await this.collect(block, receipts, state, {...options,classify:(reason,log)=>db.afterCommit(()=>this.metrics.classify(reason,log))}).flush(db);
  }
  private swap(rows: BlockRows, state: Prepared, base: Record<string, unknown>, ts: Date, tx: RpcTransaction, actor: Address | null, s: { pool: Hex; venue: string; coin: Address; quote: Address; side: 1 | -1; amountCoin: bigint; amountQuote: bigint; recipient?: Address },
    context?: { logs: RpcLog[]; poolManager: string; knownPool: (address: string) => boolean }) {
    const decimals = (a: Address) => lower(a) === native ? 18 : state.tokens.get(lower(a))?.decimals;
    const coinDecimals = decimals(s.coin); const quoteDecimals = decimals(s.quote);
    // A pool outside the sender scope: the transaction's sender is not read (no receipts for its block). The wallet
    // behind the swap comes from the coin's own transfers in the transaction (beneficiary.ts). Until 2026-10-13 these
    // swaps were stored without a trader and marked senders_pending, so coins that never launched on Pons had no
    // buyers, holder checks or sell check.
    const outside=!state.forceSenders && s.venue!=='pons_curve' && !ponsPool(state.scope,s.pool);
    const pricingPending=coinDecimals==null || quoteDecimals==null;
    if (s.amountCoin === 0n) return;
    // Not for WETH or USDG as the coin (the reference pair's own swaps, 11,500 an hour): they are never listed, and with
    // traders on them every wallet profile read WETH's whole history (five to nine seconds a wallet, 2026-10-13).
    const referenceCoin=lower(s.coin)===lower(this.registry.requireAddress('tokens.WETH')) || lower(s.coin)===lower(this.registry.requireAddress('tokens.USDG'));
    const found=outside && context && !referenceCoin ? swapWallet(context.logs,tx.hash,s.coin,s.pool,context.poolManager,s.side,context.knownPool) : null;
    // A buy that moved no coins (one hop of a route inside the v4 pool manager) was delivered to nobody: the pool manager is recorded as its recipient.
    const delivered=found?.wallet ?? (found && !found.moved && s.venue==='uniswap_v4' && s.side===1 ? context!.poolManager as Address : null);
    const trader=outside ? found?.wallet ?? null : actor;
    const recipient=outside && s.side===1 && delivered ? delivered : s.recipient;
    const pending=outside && !found;
    const amountQuote = quoteDecimals==null ? null : scaled(s.amountQuote, quoteDecimals);
    const price = amountQuote==null || coinDecimals==null ? null : amountQuote / scaled(s.amountCoin, coinDecimals);
    const ethQuote = lower(s.quote) === native || lower(s.quote) === lower(this.registry.requireAddress('tokens.WETH'));
    // USDG is the dollar the ETH/USD reference is quoted in, so a USDG amount is its USD value. Unpriced USDG swaps kept
    // coins from ever completing their USD checks (2026-10-11: 364,000 Pons swaps in seven days). Other quotes stay
    // unpriced (TODO(spec): no USD conversion is defined for them).
    const dollarQuote = lower(s.quote) === lower(this.registry.requireAddress('tokens.USDG'));
    const usd = pricingPending || amountQuote==null ? null : dollarQuote ? amountQuote : ethQuote && state.rate ? amountQuote * state.rate.value : null;
    rows.add('swaps', { ...base, ts, venue: s.venue, pool_id: binary(s.pool), coin: binary(s.coin), quote_asset: binary(s.quote), trader: trader == null ? null:binary(trader), tx_from: outside?null:binary(tx.from), tx_to:outside?null:binary(tx.to ?? native),senders_pending:pending, recipient: recipient ? binary(recipient) : null, side: s.side, amount_coin: s.amountCoin.toString(), amount_quote: s.amountQuote.toString(), price_quote: price, pricing_pending:pricingPending, usd, priced_block: usd == null ? null : dollarQuote ? String(base.block) : state.rate!.block.toString() });
    if(trader) rows.add('wallets', { address: binary(trader), block: String(base.block) });
  }
}
