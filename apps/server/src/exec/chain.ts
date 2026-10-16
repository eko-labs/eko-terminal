import { withRpcOrigin, rpcPauseRetryAt, elysium } from '@eko/chain';
import { logger } from '../obs/logger.js';
import { reportError } from '../obs/errors.js';
import { rpcOriginClient, RpcMeter, createMeteredPublicClient, safeError, type RpcEnv, type UsageStore, type RpcUsageDb } from '@eko/chain';
import {
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  parseUnits,
  padHex,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { robinhood, robinhoodTestnet } from 'viem/chains';
import { GAS_RESERVE_ETH, type NetworkDef, type NetworkHealth, type NetworkId, type Quote, type RouteDef } from '@eko/shared';
import { executionNetworks } from './networks.js';
import { metrics } from '../obs/metrics.js';
import type { ExecutionAdapter, VenueQuoteInput } from './types.js';
import { quoteV3Trade, ChainQuoteError, ERC20_ABI, FACTORY_ABI, POOL_ABI, QUOTER_V2_ABI, ROUTER_ABI, type V3TradeSources } from './v3-routes.js';
export { ChainQuoteError, ERC20_ABI, FACTORY_ABI, POOL_ABI, QUOTER_V2_ABI, ROUTER_ABI } from './v3-routes.js';
import type { TradeQuoteRequest } from '@eko/shared';

const NETWORKS = executionNetworks();

/** SwapRouter02 recipient sentinel meaning "this router" (used before unwrapping WETH → ETH). */
const ADDRESS_THIS = padHex('0x02', { size: 20 });
const QUOTE_TTL_MS = 20_000;
const DEADLINE_S = 120;
export { GAS_RESERVE_ETH };

export class ChainClients {
  readonly clients = new Map<NetworkId, PublicClient>();
  private health = new Map<NetworkId, NetworkHealth>();

  readonly meter: RpcMeter;
  /**
   * Construct the shared RPC meter and mainnet/testnet clients with unchecked degraded initial
   * health. Host-only configuration; invalid meter/client configuration can throw. No wallet
   * authentication or transaction signing occurs.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  constructor(rpc: { mainnet?: string; testnet?: string }, env: RpcEnv, store: UsageStore, db?: RpcUsageDb) {
    // TODO(spec): TEAM_ALERT_CHAT_ID pager delivery is absent; use the existing Sentry alert path.
    this.meter = new RpcMeter({ ...env, RPC_HTTP_URL: env.RPC_HTTP_URL ?? rpc.mainnet }, { db, store, log: (event, fields) => logger.info(fields, event), alert: (event, fields) => reportError(new Error(event), fields) });
    this.clients.set(
      'robinhood-mainnet',
      createMeteredPublicClient(this.meter, robinhood),
    );
    this.clients.set(
      'robinhood-testnet',
      createMeteredPublicClient(this.meter, robinhoodTestnet, rpc.testnet ?? NETWORKS['robinhood-testnet'].publicRpcUrl),
    );
    // Every NETWORKS entry has a client: Elysium reads use its public RPC (this legacy server never trades there).
    this.clients.set('elysium-mainnet', createMeteredPublicClient(this.meter, elysium, NETWORKS['elysium-mainnet'].publicRpcUrl));
    for (const n of Object.values(NETWORKS)) {
      this.health.set(n.id, { id: n.id, name: n.name, chainId: n.chainId, status: 'degraded', blockNumber: null, lastCheckedAt: null, detail: 'Not checked yet' });
    }
    this.rpcLabel = { mainnet: rpc.mainnet ? 'custom RPC' : 'public RPC (rate-limited, not for production)', testnet: rpc.testnet ? 'custom RPC' : 'public RPC' };
  }
  readonly rpcLabel: { mainnet: string; testnet: string };

  /**
   * Return the configured read client for a typed network id. Host callers select the network; no
   * wallet authentication or live chain-id validation occurs here.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  get(id: NetworkId, origin = 'server.execution'): PublicClient {
    return rpcOriginClient(this.clients.get(id)!,origin);
  }

  /**
   * Probe chain id and block height for each configured network and retain status. Public
   * operational read, no wallet authentication. Provider failures become down results with bounded
   * error details rather than rejecting individual probes.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async checkHealth(): Promise<NetworkHealth[]> {
    await Promise.all(
      [...this.clients.entries()].map(async ([id, c]) => {
        const n = NETWORKS[id];
        try {
          const [chainId, block] = await Promise.all([c.getChainId(), c.getBlockNumber()]);
          this.health.set(id, {
            id,
            name: n.name,
            chainId: n.chainId,
            status: chainId === n.chainId ? 'ok' : 'down',
            blockNumber: Number(block),
            lastCheckedAt: Date.now(),
            detail: chainId === n.chainId ? (id === 'robinhood-mainnet' ? this.rpcLabel.mainnet : this.rpcLabel.testnet) : `RPC reports chain ${chainId}, expected ${n.chainId}`,
          });
        } catch (err) {
          this.health.set(id, { id, name: n.name, chainId: n.chainId, status: 'down', blockNumber: null, lastCheckedAt: Date.now(), detail: safeError(err).slice(0, 160) });
        }
      }),
    );
    return this.healthList();
  }

  /**
   * Return the currently retained network health values, possibly empty before probing. Public
   * operational read; no live validation or authorization occurs.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  healthList() {
    return [...this.health.values()];
  }
}

interface TierQuote {
  fee: number;
  amountOut: bigint;
  gasEstimate: bigint;
}

function sqrtPriceToPrice(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  // price of token0 in token1 units
  const q = Number(sqrtPriceX96) / 2 ** 96;
  return q * q * 10 ** (dec0 - dec1);
}

/**
 * Uniswap v3 on Robinhood Chain (verified deployment; see packages/shared/src/networks.ts).
 * BUY  = USDG → WETH → unwrapped to native ETH for the wallet.
 * SELL = native ETH (wrapped by the router) → USDG.
 */
export class UniswapV3Adapter implements ExecutionAdapter {
  readonly id = 'uniswap-v3';
  readonly name = 'Uniswap v3';
  /**
   * Retain read clients, configured network, reference-price callback and clock. Host-only
   * construction without caller authentication; no quote, simulation or signing starts yet.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  constructor(
    private chains: ChainClients,
    private networkId: NetworkId,
    private ethUsd: () => number | null,
    private now: () => number = Date.now,
  ) {}

  /**
   * Read the static definition for the configured network. Host configuration only; this does not
   * verify a live endpoint or authorize execution.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  get network(): NetworkDef {
    return NETWORKS[this.networkId];
  }

  /**
   * Find a static route for a market or return null. Public route read; no RPC, wallet
   * authentication or admission checks occur.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  route(market: string): RouteDef | null {
    return NETWORKS[this.networkId].routes.find(route => route.market === market) ?? null;
  }

  /** CA-7 route fields and unsigned legs; the trade service owns Guard and binding.
   * @remarks
   * Prepare an indexed zero-terminal-fee unsigned v3 route only on mainnet and record latency.
   * Caller supplies validated request/trusted sources; no authentication/admission is performed
   * here. Wrong network and route/price/fee/provider failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async quoteTrade(input: TradeQuoteRequest, sources: V3TradeSources) {
    if (this.networkId !== 'robinhood-mainnet') throw new ChainQuoteError('no_route', 'Indexed routes require chain 4663');
    const start = performance.now();
    try { return await quoteV3Trade(this.chains.get(this.networkId), input, sources, this.now); }
    finally { metrics.observe('quote.latency_ms', performance.now() - start, { mode: 'live' }); }
  }

  /**
   * Quote supported configured fee tiers and construct unsigned swap/approval legs, recording wallet
   * balance/allowance/simulation warnings when an account is supplied. Caller owns
   * authentication/admission. Invalid amount, missing route/liquidity or provider failures reject;
   * warnings are consumed by order admission.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async quote(input: VenueQuoteInput): Promise<Quote> {
    const t0 = performance.now();
    const net = this.network;
    const route = this.route(input.market);
    if (!route) throw new ChainQuoteError('no_route', net.unsupportedReason);
    const c = net.contracts;
    if (!c.uniswapV3QuoterV2 || !c.uniswapV3SwapRouter02 || !c.uniswapV3Factory) throw new ChainQuoteError('no_route', 'Venue contracts not configured for this network');
    const client = this.chains.get(this.networkId);
    const base = route.base.token;
    const quoteTok = route.quote.token;
    const buying = input.side === 'buy';
    const tokenIn = buying ? quoteTok : base;
    const tokenOut = buying ? base : quoteTok;
    let amountInRaw: bigint;
    try {
      amountInRaw = parseUnits(input.amountIn.toFixed(Math.min(tokenIn.decimals, 12)), tokenIn.decimals);
    } catch {
      throw new ChainQuoteError('bad_amount', 'Invalid amount');
    }
    if (amountInRaw <= 0n) throw new ChainQuoteError('bad_amount', 'Amount must be positive');

    // Quote every configured fee tier and keep the best output. Distinguish "no pool/liquidity"
    // (contract reverts) from "RPC unreachable" so the user is told the right thing.
    let rpcFailures = 0;
    const tiers = await Promise.all(
      route.feeTiers.map(async (fee): Promise<TierQuote | null> => {
        try {
          const { result } = await withRpcOrigin('server.chain.rawL217',()=>client.simulateContract({
            address: c.uniswapV3QuoterV2!,
            abi: QUOTER_V2_ABI,
            functionName: 'quoteExactInputSingle',
            args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn: amountInRaw, fee, sqrtPriceLimitX96: 0n }],
          }));
          return { fee, amountOut: result[0], gasEstimate: result[3] };
        } catch (err) {
          const name = (err as { name?: string; cause?: { name?: string } }).cause?.name ?? (err as { name?: string }).name ?? '';
          if (/HttpRequestError|TimeoutError|FetchError|SocketClosedError/.test(name) || /fetch failed|ECONNREFUSED|timed out/i.test(String((err as Error).message))) rpcFailures++;
          return null;
        }
      }),
    );
    const best = tiers.filter((t): t is TierQuote => !!t && t.amountOut > 0n).sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];
    if (!best && rpcFailures === route.feeTiers.length) throw new ChainQuoteError('rpc_unavailable', `${net.name} RPC is unreachable — cannot fetch an executable quote. Execution is paused until the node responds.`);
    if (!best) throw new ChainQuoteError('no_liquidity', 'No Uniswap v3 pool could fill this size right now.');

    // Mid price from the chosen pool (for price impact vs. the pool's own spot price).
    const pool = await withRpcOrigin('server.chain.L235',()=>client.readContract({ address: c.uniswapV3Factory!, abi: FACTORY_ABI, functionName: 'getPool', args: [base.address, quoteTok.address, best.fee] }));
    const [slot0, token0] = await Promise.all([
      withRpcOrigin('server.chain.L237',()=>client.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0' })),
      withRpcOrigin('server.chain.L238',()=>client.readContract({ address: pool, abi: POOL_ABI, functionName: 'token0' })),
    ]);
    const baseIs0 = token0.toLowerCase() === base.address.toLowerCase();
    const p0in1 = sqrtPriceToPrice(slot0[0], baseIs0 ? base.decimals : quoteTok.decimals, baseIs0 ? quoteTok.decimals : base.decimals);
    const poolMid = baseIs0 ? p0in1 : 1 / p0in1; // quote per base

    const amountOut = Number(formatUnits(best.amountOut, tokenOut.decimals));
    const execPrice = buying ? input.amountIn / amountOut : amountOut / input.amountIn;
    const lpFeeFrac = best.fee / 1_000_000;
    const idealOut = buying ? (input.amountIn * (1 - lpFeeFrac)) / poolMid : input.amountIn * poolMid * (1 - lpFeeFrac);
    const priceImpactBps = Math.max(0, ((idealOut - amountOut) / idealOut) * 10_000);
    const minOutRaw = (best.amountOut * BigInt(10_000 - input.slippageBps)) / 10_000n;
    const minOut = Number(formatUnits(minOutRaw, tokenOut.decimals));

    const deadline = BigInt(Math.floor(this.now() / 1000) + DEADLINE_S);
    const recipient = input.account ?? padHex('0x01', { size: 20 });
    const calls: Hex[] = [
      encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: tokenIn.address,
            tokenOut: tokenOut.address,
            fee: best.fee,
            recipient: buying ? ADDRESS_THIS : recipient,
            amountIn: amountInRaw,
            amountOutMinimum: minOutRaw,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    ];
    if (buying) calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [minOutRaw, recipient] }));
    const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [deadline, calls] });
    const value = buying ? 0n : amountInRaw;

    // Balances, allowance, gas and simulation (only possible with a wallet address).
    const warnings: string[] = [...route.notes.slice(0, 1)];
    let approval: NonNullable<Quote['tx']>['approval'] = null;
    let gasUnits = best.gasEstimate + 60_000n;
    const gasPrice = await client.getGasPrice();
    const account=input.account;
    if (account) {
      const [ethBal, inBal] = await Promise.all([
        client.getBalance({ address: account }),
        buying ? withRpcOrigin('server.chain.L283',()=>client.readContract({ address: quoteTok.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] })) : Promise.resolve(0n),
      ]);
      if (buying) {
        if (inBal < amountInRaw) warnings.push(`insufficient_balance: wallet holds ${formatUnits(inBal, quoteTok.decimals)} ${quoteTok.symbol}`);
        const allowance = await withRpcOrigin('server.chain.L287',()=>client.readContract({ address: quoteTok.address, abi: ERC20_ABI, functionName: 'allowance', args: [account, c.uniswapV3SwapRouter02!] }));
        if (allowance < amountInRaw) approval = { token: quoteTok.address, spender: c.uniswapV3SwapRouter02!, amount: amountInRaw.toString() };
      } else {
        const reserve = parseUnits(String(GAS_RESERVE_ETH), 18);
        if (ethBal < amountInRaw + reserve) warnings.push(`insufficient_balance: wallet holds ${formatUnits(ethBal, 18)} ETH (keep ≥ ${GAS_RESERVE_ETH} ETH for gas)`);
      }
      if (!approval && !warnings.some((w) => w.startsWith('insufficient_balance'))) {
        try {
          await withRpcOrigin('server.chain.rawL297',()=>client.call({ account: input.account, to: c.uniswapV3SwapRouter02!, data, value }));
          gasUnits = await client.estimateGas({ account: input.account, to: c.uniswapV3SwapRouter02!, data, value });
          metrics.observe('simulation.failure', 0, { mode: input.mode });
        } catch (err) {
          metrics.observe('simulation.failure', 1, { mode: input.mode });
          warnings.push(`simulation_failed: ${((err as { shortMessage?: string }).shortMessage ?? (err as Error).message).slice(0, 160)}`);
        }
      } else if (approval) {
        warnings.push('approval_required: a one-time USDG approval must confirm before the swap can be simulated.');
      }
    } else {
      warnings.push('Connect a wallet to check balances, allowance and simulate the transaction.');
    }
    const gasEth = Number(formatUnits(gasUnits * gasPrice, 18));
    const eth = this.ethUsd();
    const latencyMs = performance.now() - t0;
    metrics.observe('quote.latency_ms', latencyMs, { venue: 'uniswap-v3', mode: input.mode });
    const quotedAt = this.now();
    return {
      id: input.id,
      mode: input.mode,
      market: input.market,
      side: input.side,
      network: net.id,
      venue: this.id,
      venueName: `${this.name} · ${(best.fee / 10_000).toFixed(2)}% pool`,
      assetIn: buying ? quoteTok.symbol : route.base.symbol,
      assetOut: buying ? route.base.symbol : quoteTok.symbol,
      amountIn: input.amountIn,
      expectedOut: amountOut,
      minOut,
      price: execPrice,
      referenceMid: input.referenceMid,
      priceImpactBps,
      slippageBps: input.slippageBps,
      fees: [
        { label: `LP fee (${(best.fee / 10_000).toFixed(2)}%)`, amount: input.amountIn * lpFeeFrac, asset: buying ? quoteTok.symbol : route.base.symbol, estimated: false },
        { label: 'Network fee (L2 + L1 data)', amount: gasEth, asset: 'ETH', estimated: true },
        ...(eth ? [{ label: 'Network fee ≈ USD', amount: gasEth * eth, asset: 'USD', estimated: true }] : []),
      ],
      quotedAt,
      expiresAt: quotedAt + QUOTE_TTL_MS,
      latencyMs,
      priceSource: `QuoterV2 on ${net.name} (block-time quote)`,
      simulated: false,
      account: input.account?.toLowerCase() ?? null,
      tx: {
        chainId: net.chainId,
        approval,
        swap: { to: c.uniswapV3SwapRouter02!, data, value: value.toString() },
        amountInRaw: amountInRaw.toString(),
        minOutRaw: minOutRaw.toString(),
        tokenIn: { address: tokenIn.address, decimals: tokenIn.decimals, symbol: buying ? quoteTok.symbol : 'ETH' },
        tokenOut: { address: tokenOut.address, decimals: tokenOut.decimals, symbol: buying ? 'ETH' : quoteTok.symbol },
      },
      warnings,
    };
  }

  /**
   * Parse a confirmed swap receipt into actual amounts using the pool's Swap event.
   * Returns null if no decodable Swap log is present; emitter authentication is not performed here.
   * @remarks
   * Parse the first decodable Swap log into quantities using configured token order/decimals; it
   * does not authenticate the log emitter against a known pool. Caller must validate the transaction
   * separately. Unknown route or no decodable log returns null.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  parseSwap(receipt: TransactionReceipt, market: string): { baseQty: number; quoteQty: number; price: number } | null {
    const route = this.route(market);
    if (!route) return null;
    const base = route.base.token;
    const quote = route.quote.token;
    const baseIs0 = BigInt(base.address) < BigInt(quote.address);
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: POOL_ABI, data: log.data, topics: log.topics });
        if (ev.eventName !== 'Swap') continue;
        const a0 = ev.args.amount0 < 0n ? -ev.args.amount0 : ev.args.amount0;
        const a1 = ev.args.amount1 < 0n ? -ev.args.amount1 : ev.args.amount1;
        const baseRaw = baseIs0 ? a0 : a1;
        const quoteRaw = baseIs0 ? a1 : a0;
        const baseQty = Number(formatUnits(baseRaw, base.decimals));
        const quoteQty = Number(formatUnits(quoteRaw, quote.decimals));
        if (baseQty > 0) return { baseQty, quoteQty, price: quoteQty / baseQty };
      } catch {
        /* not a Swap log */
      }
    }
    return null;
  }

  /**
   * Read a transaction receipt through the configured network client. Public chain read, no wallet
   * authentication; provider pauses propagate retry timing; other provider/not-found failures return null.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async receipt(hash: Hex): Promise<TransactionReceipt | null> {
    try {
      return await this.chains.get(this.networkId).getTransactionReceipt({ hash });
    } catch (error) {
      if (rpcPauseRetryAt(error)!==undefined)throw error;
      return null;
    }
  }

  /**
   * Read a transaction through the configured network client. Public chain read, no wallet
   * authentication; provider pauses propagate retry timing; other provider/not-found failures return null.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async transaction(hash: Hex) {
    try {
      return await this.chains.get(this.networkId).getTransaction({ hash });
    } catch (error) {
      if (rpcPauseRetryAt(error)!==undefined)throw error;
      return null;
    }
  }
}
