import { agentRegistryReadAbi } from './agent-registry.js';
import { createPublicClient, toHex, parseAbi, type Address, type Hex } from 'viem';
import { createMeteredClients, rpcStopReason, isRpcUnavailable, type AddressRegistry, type RpcEnv, type RpcMeter } from '@eko/chain';
import type { ChainClient, RpcBlock, RpcLog, RpcReceipt, TokenMetadata, EthUsdRate, EthUsdSource } from './types.js';
import { budgetedQueries } from './log-budget.js';
import { ethUsdFromSlot0 } from './price.js';
const metadataAbi = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)', 'function totalSupply() view returns (uint256)']);
const factoryAbi = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)']);
const priceAbi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)', 'function liquidity() view returns (uint128)', 'function token0() view returns (address)']);
const poolAbi = parseAbi(['function factory() view returns (address)', 'function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)', 'function tickSpacing() view returns (int24)']);
/**
 * Wire metered role-routed RPC adapters and pinned Multicall reads from host
 * configuration/registry. Indexer host only; no wallet auth or keys. Missing manifest
 * targets/configuration throws; returned reads propagate provider/budget failures except their
 * documented nullable outcomes.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
 */
export function createClients(env: RpcEnv, registry: AddressRegistry, meter: RpcMeter, options: { head?: boolean; enrich?: boolean } = {}): ChainClient {
  const { paid: client, reads, archive, public: backfill, head: live, headTimestamp, headWs } = createMeteredClients(env, { meter });
  const enrichment=createPublicClient({transport:meter.transport('enrich')});
  // Public first; a failed read goes to paid. Public-only parent reads stalled the indexer for minutes whenever the
  // public RPC throttled (2026-10-09: 870 retries in 12 minutes, a stall restart, 5-8 minutes behind the chain).
  const publicHeaders=createPublicClient({transport:meter.transport('parent')});
  type Reader = typeof enrichment;
  const stateReads=(options.enrich ? enrichment : reads) as unknown as Reader;
  const metadataReads=(options.enrich ? enrichment : archive) as unknown as Reader;
  const archiveReads=archive as unknown as Reader;
  const checkGuard = (results: readonly { status: string; error?: unknown }[]) => {
    for (const result of results) if (result.status === 'failure' && (rpcStopReason(result.error) || isRpcUnavailable(result.error))) throw result.error;
  };
  /**
   * Pinned (archive) reads are paid-only. Once the paid daily budget is spent, the same pinned read is tried on the
   * public lane, which still holds recent state (near the head). When it cannot serve the block either, the paid
   * budget error stands; the live head loop waits that out instead of halting.
   */
  const pinned = async <T>(paid: Reader, read: (c: Reader) => Promise<T>): Promise<T> => {
    try { return await read(paid); }
    catch (error) {
      if (paid === enrichment || rpcStopReason(error) !== 'rpc_budget_exhausted') throw error;
      try { return await read(enrichment); }
      catch (fallback) { const reason = rpcStopReason(fallback); if (reason && reason !== 'rpc_budget_exhausted') throw fallback; throw error; }
    }
  };
  let referenceRead:Promise<EthUsdRate|null>|undefined;
  let referencePool: EthUsdSource & { weth0: boolean } | undefined;
  const multicallAddress = registry.requireAddress('multicall3');
  /**
   * Read decimals/symbol/name/supply in pinned bounded Multicalls and preserve null for individually
   * failed fields. Indexer host call without wallet auth; all-field failure or provider/budget
   * closure rejects, empty input returns empty output. Unknown decimals are not fabricated.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  const tokenMetadataBatch = async (addresses: Address[], blockNumber: bigint): Promise<TokenMetadata[]> => {
    if (!addresses.length) return [];
    const fields = ['decimals', 'symbol', 'name', 'totalSupply'] as const;
    const results = await pinned(metadataReads, async c => { const read = await c.multicall({ multicallAddress, blockNumber, allowFailure: true, batchSize: 8192, contracts: addresses.flatMap(address => fields.map(functionName => ({ address, abi: metadataAbi, functionName }))) }); checkGuard(read); return read; });
    if (results.every(r => r.status === 'failure')) throw new Error('Token metadata archive read failed');
    return addresses.map((_, i) => {
      const value = (offset: number) => { const result = results[i * 4 + offset]; return result.status === 'success' ? result.result : null; };
      return { decimals: typeof value(0) === 'number' ? value(0) as number : null, symbol: typeof value(1) === 'string' ? value(1) as string : null, name: typeof value(2) === 'string' ? value(2) as string : null, totalSupply: typeof value(3) === 'bigint' ? value(3) as bigint : null, supplyBlock: typeof value(3) === 'bigint' ? blockNumber : null };
    });
  };
  // Raw RPC keeps receipt/log quantities identical to captured fixtures, including system transactions.
  const request = async <T>(method: string, params: unknown[]): Promise<T> => client.request({ method, params } as never) as Promise<T>;
  return {
    /**
     * Expose the meter's current stop latch without I/O or authentication. Public worker diagnostic
     * read; this is not a chain health assertion.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    rpcStopped: () => meter.isStopped,
    /**
     * Report whether the meter has closed today's paid budget, without I/O or authentication. Public worker diagnostic
     * read for lane logging; admission itself enforces the budget.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    paidExhausted: () => meter.paidExhausted,
    /**
     * Return a copy of cumulative meter timing without I/O or authentication. Public worker diagnostic
     * read; timing does not authenticate provider data.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    rpcTiming: () => ({ ...meter.timing }),
    /**
     * Read chain id through the configured metered client. Indexer operator selects endpoint; no
     * wallet auth; RPC/budget failures reject.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    chainId: () => client.getChainId(), /**
   * Read uncached block height through head or ordinary metered routing. Indexer host call without
   * wallet auth; RPC/budget failures reject and caller validates chain.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  head: () => (options.head ? live : client).getBlockNumber({ cacheTime: 0 }),
    /**
     * Read a full raw block with transactions at the specified number through metered RPC. Indexer
     * host call without wallet auth; RPC/budget failures reject; consumer checks canonical
     * consistency.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    block: n => request<RpcBlock>('eth_getBlockByNumber', [toHex(n), true]),
    /**
     * Read a raw header at the specified number through enrichment or ordinary metered routing.
     * Indexer host call without wallet auth; RPC/budget failures reject; consumer checks number/hash.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    header: n => options.enrich ? enrichment.request({method:'eth_getBlockByNumber',params:[toHex(n),false]} as never) as Promise<RpcBlock> : request<RpcBlock>('eth_getBlockByNumber', [toHex(n), false]),
    /**
     * Read a raw parent header through the public metered route. Indexer host call without wallet
     * auth; RPC/budget failures reject; parent-chain authentication belongs to ingest.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    parentHeader: n => publicHeaders.request({method:'eth_getBlockByNumber',params:[toHex(n),false]} as never) as Promise<RpcBlock>,
    /**
     * Read a raw header through the timestamp/head metered route. Indexer host call without wallet
     * auth; RPC/budget failures reject; ingest verifies timestamp/header binding.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    timestampHeader: n => headTimestamp.request({method:'eth_getBlockByNumber',params:[toHex(n),false]} as never) as Promise<RpcBlock>,
    /**
     * Read raw block receipts through enrichment/head/ordinary metered routing as configured. Indexer
     * host call without wallet auth; RPC/budget failures reject and ingest validates receipt/log
     * bindings.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    receipts: n => (options.enrich ? enrichment : options.head ? live : client).request({method:'eth_getBlockReceipts',params:[toHex(n)]} as never) as Promise<RpcReceipt[]>,
    /**
     * Split filters to provider address/block budgets and collect logs from head/public backfill
     * routes. Indexer host call without wallet auth; RPC/budget failures reject and caller checks
     * emitters/canonical blocks.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    async logs(input) {
      const logs: RpcLog[] = [];
      for (const { from, to, address, addresses, topics, topicFilters } of budgetedQueries(input)) logs.push(...await (options.head ? live : backfill).request({ method: 'eth_getLogs', params: [{ fromBlock: toHex(from), toBlock: toHex(to), ...(addresses ? { address: addresses } : address ? { address } : {}), topics: topicFilters ?? [topics] }] } as never) as RpcLog[]);
      return logs;
    },
    /**
     * Read raw timestamp-probe logs for the supplied topic/range through metered RPC. Indexer host
     * call without wallet auth; RPC/budget failures reject; this does not itself authenticate log
     * timestamps.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    timestampLogs: input => request<RpcLog[]>('eth_getLogs',[{fromBlock:toHex(input.from),toBlock:toHex(input.to),topics:[input.topics]}]),
    /**
     * Read code at a pinned block through the configured state route, mapping undefined to 0x. Indexer
     * host call without wallet auth; RPC/budget failures reject and caller checks expected code hash.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    code: async (address, blockNumber) => (await pinned(stateReads, c => c.getCode({ address, blockNumber }))) ?? '0x',
    /**
     * Read one token through pinned batch metadata acquisition, retaining null for unavailable
     * optional fields. Indexer host call without wallet auth; full batch failure or transport/budget
     * failure rejects; untrusted identity text is not instructions.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    tokenMetadata: async (address, n) => (await tokenMetadataBatch([address], n))[0],
    tokenMetadataBatch,
    /**
     * Read owner/wallet/tokenURI at the supplied block in batches of 200 ids. Indexer host call
     * without wallet auth; missing owner/wallet, incomplete results or provider/budget failures
     * reject; tokenURI alone may be null.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    async agentWallets(ids, blockNumber) {
      const result: { owner: Address; wallet: Address; tokenUri: string | null }[] = [];
      for (let offset=0;offset<ids.length;offset+=200) {
        const results=await pinned(archiveReads,async c=>{const read=await c.multicall({multicallAddress,blockNumber,allowFailure:true,batchSize:8192,
          contracts:ids.slice(offset,offset+200).flatMap(id=>(['ownerOf','getAgentWallet','tokenURI'] as const).map(functionName=>({
            address:registry.requireAddress('erc8004.identityRegistry'),abi:agentRegistryReadAbi,functionName,args:[id] as const}))) });checkGuard(read);return read;});
        if(results.length!==Math.min(200,ids.length-offset)*3)throw new Error('Incomplete registry batch');
        for(let i=0;i<results.length;i+=3) {
          const owner=results[i],wallet=results[i+1],uri=results[i+2];
          if(owner.status!=='success'||wallet.status!=='success')throw new Error('Registry wallet/owner read unavailable');
          result.push({owner:owner.result as Address,wallet:wallet.result as Address,tokenUri:uri.status==='success'?uri.result as string:null});
        }
      }
      return result;
    },
    /**
     * Discover the deepest initialized standard-fee WETH/USDG pool from the configured factory at a
     * pin, retain its address, then read pinned slot0 on later calls. Indexer host call without wallet
     * auth. No initialized pool returns null; invalid currencies, missing reads or provider/budget
     * failures reject. This is a spot conversion, not an independent USD oracle.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    async ethUsdRate(blockNumber) {
      // Adjacent sample periods can prefetch together; discover the reference once.
      if(!referencePool&&referenceRead)await referenceRead;
      if (referencePool) {
        const pool = referencePool;
        const slot = await pinned(archiveReads, c => c.readContract({ address: pool.address,blockNumber,abi:priceAbi,functionName:'slot0' }));
        return { value:ethUsdFromSlot0(slot[0],referencePool.weth0,registry.data.tokens.WETH.decimals!,registry.data.tokens.USDG.decimals!),block:blockNumber, source: { address: referencePool.address, venue: referencePool.venue, fee: referencePool.fee } };
      }
      const discover=async():Promise<EthUsdRate|null>=>{
        const weth = registry.requireAddress('tokens.WETH'), usdg = registry.requireAddress('tokens.USDG');
        // TODO(spec): No preferred WETH/USDG fee tier is specified; use the deepest initialized standard-fee pool at the sample block.
        const fees = [100, 500, 3000, 10000];
        const candidates = await pinned(archiveReads, async c => { const read = await c.multicall({ multicallAddress, blockNumber, allowFailure: true, contracts: fees.map(fee => ({ address: registry.requireAddress('uniswapV3.factory'), abi: factoryAbi, functionName: 'getPool', args: [weth, usdg, fee] as const })) }); checkGuard(read); return read; });
        if (candidates.every(r => r.status === 'failure')) throw new Error('ETH/USD archive discovery failed');
        const addresses = [...new Set(candidates.flatMap(r => r.status === 'success' && lower(r.result) !== native ? [r.result] : []))];
        if (!addresses.length) return null; // Before the reference market existed.
        const reads = await pinned(archiveReads, async c => { const read = await c.multicall({ multicallAddress, blockNumber, allowFailure: true, contracts: addresses.flatMap(address => (['slot0', 'liquidity', 'token0'] as const).map(functionName => ({ address, abi: priceAbi, functionName }))) }); checkGuard(read); return read; });
        let best: { liquidity: bigint; value: number; address: Address; weth0: boolean; fee: number } | null = null;
        for (let i = 0; i < addresses.length; i++) {
          const slot = reads[i * 3], liq = reads[i * 3 + 1], token = reads[i * 3 + 2];
          if (slot.status !== 'success' || liq.status !== 'success' || token.status !== 'success') continue;
          const liquidity = liq.result as bigint; const sqrtPriceX96 = (slot.result as readonly unknown[])[0] as bigint;
          if (liquidity === 0n || sqrtPriceX96 === 0n) continue;
          const token0 = token.result as Address;
          if (![weth, usdg].some(a => lower(a) === lower(token0))) throw new Error('Unexpected ETH/USD pool currencies');
          const value = ethUsdFromSlot0(sqrtPriceX96, lower(token0) === lower(weth), registry.data.tokens.WETH.decimals!, registry.data.tokens.USDG.decimals!);
          if (!best || liquidity > best.liquidity) best = { liquidity, value, address: addresses[i], weth0: lower(token0) === lower(weth), fee: fees[candidates.findIndex(r => r.status === 'success' && lower(r.result) === lower(addresses[i]))] };
        }
        if (!best && reads.some(r => r.status === 'failure')) throw new Error('ETH/USD archive slot0 read failed');
        if (best) referencePool = { address:best.address,weth0:best.weth0,venue:'uniswap_v3',fee:best.fee };
        return best ? { value: best.value, block: blockNumber, source: { address: best.address, venue: 'uniswap_v3', fee: best.fee } } : null;
      };
      const read=referenceRead=discover();
      try {return await read;} finally {if(referenceRead===read)referenceRead=undefined;}

    },
    /**
     * Read pinned factory/token/fee/tick-spacing fields with Multicall. Indexer host call without
     * wallet auth; contract revert/no-data or zero factory returns null while transport/budget
     * failures reject. Nonzero factory alone is not canonical-factory authentication.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    async v3Pool(address, blockNumber) {
      try {
        // One pinned Multicall instead of a serial factory read and four independent calls.
        const results = await pinned(stateReads, async c => { const read = await c.multicall({ multicallAddress, blockNumber, allowFailure: true,
          contracts: (['factory', 'token0', 'token1', 'fee', 'tickSpacing'] as const).map(functionName => ({address, abi: poolAbi, functionName})) }); checkGuard(read); return read; });
        const factory = results[0];
        if (factory.status === 'failure') throw factory.error;
        if (lower(factory.result as Address) === native) return null;
        for (const result of results) if (result.status === 'failure') throw result.error;
        const [,currency0,currency1,fee,tickSpacing] = results.map(r => r.status === 'success' ? r.result : null) as [Address,Address,Address,number,number];
        return { currency0, currency1, fee, tickSpacing };
      } catch (error) {
        // Contract reverts mean this emitter is not a readable v3 pool; transport failures must retry the block.
        if (rpcStopReason(error) || isRpcUnavailable(error)) throw error;
        if (error instanceof Error && /revert|returned no data/i.test(error.message)) return null;
        throw error;
      }
    },
    /**
     * Read the registry's canonical v3 factory for the pool of a currency pair and fee at a pin: the address a
     * contract must have to be that factory's pool (v3Pool's own factory() answer proves nothing). Indexer host call
     * without wallet auth; a zero address or a revert returns null while transport/budget failures reject.
     * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
     */
    async canonicalV3Pool(token0, token1, fee, blockNumber) {
      try {
        const pool = await pinned(stateReads, c => c.readContract({ address: registry.requireAddress('uniswapV3.factory'), abi: factoryAbi, functionName: 'getPool', args: [token0, token1, fee], blockNumber })) as Address;
        return lower(pool) === native ? null : pool;
      } catch (error) {
        if (rpcStopReason(error) || isRpcUnavailable(error)) throw error;
        if (error instanceof Error && /revert|returned no data/i.test(error.message)) return null;
        throw error;
      }
    },
    ...(headWs ? { /**
   * Subscribe to metered WebSocket block-number notifications with missed-head emission and caller
   * error callback. Indexer host call without wallet auth; returned unwatch releases the
   * subscription. Callback/provider failures use the client's subscription error path and
   * notifications are not canonical block proofs.
   * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../docs/security/INVARIANTS.md | Canonical ingest and reorg invariants}
   */
  watch: (onHead: (n: bigint) => void, onError: (error: unknown) => void) => headWs.watchBlockNumber({ emitMissed: true, onBlockNumber: onHead, onError }) } : {}),
  };
}
export const native: Address = `0x${'0'.repeat(40)}`;
export const lower = (address: string): Hex => address.toLowerCase() as Hex;
