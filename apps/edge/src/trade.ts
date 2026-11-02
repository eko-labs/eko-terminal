import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import type { ElysiumRegistry, V4PoolKey } from '@eko/chain';
import { CHAIN_ID, TradeQuoteRequestSchema, type GuardCheck, type TradeOrder, type TradeQuote, type TradeQuoteRequest, type UnsignedTx } from '@eko/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Assessment } from './assess.js';
import type { CoinState, Rpc } from './tracker.js';
import { swapAbi, TRANSFER_TOPIC } from './tracker.js';

/**
 * Wallet trading on Elysium, no custody and no fee: EKO quotes a Montra coin on Uniswap v4, builds the Universal
 * Router call for the user's own wallet to sign, and simulates that exact call from that wallet before handing it
 * over. A call that would revert, or pay less than the minimum, is never returned.
 *
 * The call is the shape Elysium's own swaps use (decoded from mainnet transactions, 2026-11-11): one V4_SWAP command
 * with SETTLE (pay in: native HYPE from the call's value on a buy, the coin through Permit2 on a sell), then
 * SWAP_EXACT_IN_SINGLE (the minimum out is enforced inside the swap), then TAKE (the whole output to the wallet).
 */
export const universalRouterAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
export const v4QuoterAbi = parseAbi(['function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)']);
const erc20Abi = parseAbi(['function allowance(address owner, address spender) view returns (uint256)', 'function balanceOf(address owner) view returns (uint256)']);
const permit2Abi = parseAbi(['function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)']);

const V4_SWAP = '0x10', SETTLE = 0x0b, SWAP_EXACT_IN_SINGLE = 0x06, TAKE = 0x0e;
const poolKeyType = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] } as const;

/** The Universal Router call for one exact-in swap on a native-HYPE pool (currency0 is HYPE). */
export function buildSwap(key: V4PoolKey, side: 'buy' | 'sell', amountIn: bigint, minOut: bigint, recipient: Address, deadline: bigint): { data: Hex; value: bigint } {
  if (key.currency0 !== zeroAddress) throw new Error('Only native-HYPE pools are traded');
  const buy = side === 'buy', input = buy ? key.currency0 : key.currency1, output = buy ? key.currency1 : key.currency0;
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [input, amountIn, !buy]);
  const swap = encodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', ...poolKeyType }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'reserved', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }], [{ poolKey: key, zeroForOne: buy, amountIn, amountOutMinimum: minOut, reserved: 0n, hookData: '0x' }]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [output, recipient, 0n]);
  const actions = `0x${[SETTLE, SWAP_EXACT_IN_SINGLE, TAKE].map(a => a.toString(16).padStart(2, '0')).join('')}` as Hex;
  const v4 = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [settle, swap, take]]);
  return { data: encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [V4_SWAP, [v4], deadline] }), value: buy ? amountIn : 0n };
}

export interface TradeDeps {
  db: DatabaseSync; rpc: Rpc; registry: ElysiumRegistry;
  coin: (address: string) => CoinState | undefined;
  /** A fresh check for the coin (pool key, verdict, probe); undefined when it cannot be checked now. */
  assess: (coin: CoinState) => Promise<Assessment | undefined>;
  hypeUsd: () => number | null;
  maxTradeUsd: number;
  now?: () => number;
  onOrder?: (accountId: string, order: TradeOrder) => void;
}

interface StoredQuote { quote: TradeQuote; key: V4PoolKey; amountIn: bigint; minOut: bigint; at: number }
const QUOTE_TTL_MS = 30_000;
const hex = (n: bigint) => `0x${n.toString(16)}`;

export class Trading {
  private readonly quotes = new Map<string, StoredQuote>();
  readonly router: Address; readonly permit2: Address;
  constructor(private readonly d: TradeDeps) {
    this.router = d.registry.address('uniswapV4.universalRouter212'); this.permit2 = d.registry.address('uniswapV4.permit2');
    d.db.exec(`CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, wallet TEXT NOT NULL, quote_id TEXT NOT NULL, idem TEXT NOT NULL,
      coin TEXT NOT NULL, side TEXT NOT NULL, amount_in TEXT NOT NULL, min_out TEXT NOT NULL, status TEXT NOT NULL, tx_hash TEXT, filled_in TEXT, filled_out TEXT,
      error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(account_id, idem));
      CREATE INDEX IF NOT EXISTS orders_account ON orders(account_id, created_at);
      CREATE INDEX IF NOT EXISTS orders_status ON orders(status);`);
  }
  private now() { return this.d.now?.() ?? Date.now(); }
  private async call(to: Address, data: Hex, block: string | bigint = 'latest', from?: Address, value?: bigint): Promise<Hex> {
    return await this.d.rpc.request({ method: 'eth_call', params: [{ to, data, ...(from ? { from } : {}), ...(value ? { value: hex(value) } : {}) }, typeof block === 'bigint' ? hex(block) : block] }) as Hex;
  }

  async quote(input: TradeQuoteRequest, wallet: Address | null): Promise<TradeQuote> {
    const coin = this.d.coin(input.coin);
    if (!coin) throw Object.assign(new Error('EKO trades Montra coins it follows (launched in the last 24 hours).'), { code: 'not_found', status: 404 });
    const hypeUsd = this.d.hypeUsd();
    if (!hypeUsd) throw Object.assign(new Error('The HYPE price is unavailable; try again in a minute.'), { code: 'price_unavailable', status: 503 });
    if (!(input.amountUsd > 0) || input.amountUsd > this.d.maxTradeUsd) throw Object.assign(new Error(`Trades are $1 to $${this.d.maxTradeUsd}.`), { code: 'amount_out_of_range', status: 400 });
    const slippage = Math.round(input.slippageBps);
    if (!(slippage >= 10 && slippage <= 5000)) throw Object.assign(new Error('Slippage must be 0.1% to 50%.'), { code: 'bad_request', status: 400 });
    // The Universal Router trades only in Uniswap's own PoolManager (not the unbranded launcher's fork).
    if (coin.manager.toLowerCase() !== this.d.registry.address('uniswapV4.poolManager').toLowerCase())
      throw Object.assign(new Error('This coin trades in a PoolManager EKO cannot route to yet.'), { code: 'route_unavailable', status: 409 });
    const a = await this.d.assess(coin);
    const key = a?.key;
    if (!a || !key || key.currency0 !== zeroAddress) throw Object.assign(new Error('This coin\'s pool could not be read; try again shortly.'), { code: 'route_unavailable', status: 503 });
    const priceHype = coin.trades.at(-1)?.priceHype ?? 0;
    const buy = input.side === 'buy';
    let amountIn = buy ? BigInt(Math.floor((input.amountUsd / hypeUsd) * 1e6)) * 10n ** 12n : priceHype > 0 ? BigInt(Math.floor((input.amountUsd / hypeUsd / priceHype) * 1e6)) * 10n ** 12n : 0n;
    if (!buy && wallet) {
      const bal = BigInt(await this.call(coin.token, encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })));
      if (bal < amountIn) amountIn = bal;
    }
    if (amountIn <= 0n) throw Object.assign(new Error(buy ? 'Amount too small.' : 'Nothing to sell.'), { code: 'amount_out_of_range', status: 400 });
    const out = await this.call(this.d.registry.address('uniswapV4.v4Quoter'), encodeFunctionData({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: buy, exactAmount: amountIn, hookData: '0x' }] }))
      .catch(() => { throw Object.assign(new Error('The pool would not quote this trade.'), { code: 'quote_failed', status: 409 }); });
    const [expectedOut, gas] = decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', data: out });
    const minOut = (expectedOut * BigInt(10_000 - slippage)) / 10_000n;
    // Price impact against the last trade's price: what the quote pays per token versus the market.
    const execPrice = buy ? Number(amountIn) / Math.max(1, Number(expectedOut)) : Number(expectedOut) / Math.max(1, Number(amountIn));
    const impactBps = priceHype > 0 ? Math.max(0, Math.round((buy ? execPrice / priceHype - 1 : 1 - execPrice / priceHype) * 10_000)) : 0;
    const gasPrice = BigInt(await this.d.rpc.request({ method: 'eth_gasPrice', params: [] }) as Hex);
    const checks = this.guard(a, impactBps, buy);
    const decision = checks.some(c => c.status === 'refuse') ? 'refuse' : checks.some(c => c.status === 'warn') ? 'warn' : 'allow';
    const approvals: TradeQuote['approvals'] = [];
    if (!buy) {
      // The web app refuses a Permit2 allowance that lasts over 30 minutes; 25 leaves room for clock drift.
      const expiry = Math.floor(this.now() / 1000) + 1500;
      const erc20 = wallet ? BigInt(await this.call(coin.token, encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [wallet, this.permit2] }))) : 0n;
      if (erc20 < amountIn) approvals.push({ token: coin.token, spender: this.permit2, amount: amountIn.toString(), kind: 'erc20' });
      let p2ok = false;
      if (wallet) {
        const [amt, exp] = decodeFunctionResult({ abi: permit2Abi, functionName: 'allowance', data: await this.call(this.permit2, encodeFunctionData({ abi: permit2Abi, functionName: 'allowance', args: [wallet, coin.token, this.router] })) });
        p2ok = amt >= amountIn && exp > Math.floor(this.now() / 1000) + 120;
      }
      if (!p2ok) approvals.push({ token: coin.token, spender: this.router, amount: amountIn.toString(), kind: 'permit2', expiration: expiry });
    }
    const id = `q_${randomBytes(10).toString('hex')}`;
    const quote: TradeQuote = {
      id, coin: coin.token, side: input.side, amountUsd: input.amountUsd, binding: decision !== 'refuse', ...(wallet ? { account: wallet } : {}),
      amountIn: amountIn.toString(), valueWei: (buy ? amountIn : 0n).toString(), networkFeeUsd: (Number(gas + 120_000n) * Number(gasPrice) / 1e18) * hypeUsd,
      route: { venue: 'uniswap_v4', poolId: coin.poolId, executable: true }, expectedOut: expectedOut.toString(), minOut: minOut.toString(), priceImpactBps: impactBps,
      buyTaxPct: a.taxPct ? a.taxPct.buy : a.currentBuyFeePips !== null ? a.currentBuyFeePips / 1e4 : 0, sellTaxPct: a.taxPct ? a.taxPct.sell : a.config ? a.config.totalFeePips / 1e4 : 0,
      exitCostPct: a.probe?.exitCostPct ?? 0, fee: { bps: 0, usd: 0, destination: null }, approvals,
      guard: { decision, checks }, expiresAt: new Date(this.now() + QUOTE_TTL_MS).toISOString(), asOfBlock: a.block,
    };
    this.quotes.set(id, { quote, key, amountIn, minOut, at: this.now() });
    for (const [k, q] of this.quotes) if (this.now() - q.at > QUOTE_TTL_MS * 4) this.quotes.delete(k);
    return quote;
  }

  /** Guard checks from the coin's live verdict. A confirmed honeypot refuses a buy; Danger and a pending check warn. */
  guard(a: Assessment, impactBps: number, buy: boolean): GuardCheck[] {
    const honeypot = a.verdict.playbooks.some(m => m.id === 'honeypot' && m.level === 'danger');
    const checks: GuardCheck[] = [
      { code: 'honeypot', status: honeypot ? (buy ? 'refuse' : 'warn') : 'pass', label: honeypot ? 'A buy-then-sell check could not sell this coin.' : 'A buy-then-sell check sold it back.' },
      { code: 'verdict', status: a.verdict.level === 'danger' ? 'warn' : a.verdict.level === 'pending' ? 'warn' : 'pass',
        label: a.verdict.level === 'danger' ? 'EKO rates this coin Danger.' : a.verdict.level === 'pending' ? 'EKO has not finished checking this coin.' : `EKO rates this coin ${a.verdict.level}.` },
    ];
    if (a.antiSnipe) checks.push({ code: 'anti_snipe', status: 'warn', label: `Montra's early-buy fee is active (${a.antiSnipe.taxPct}% for ${a.antiSnipe.endsInSec} s).`, value: a.antiSnipe.taxPct });
    if (impactBps >= 1000) checks.push({ code: 'price_impact', status: 'warn', label: `This trade moves the price ${(impactBps / 100).toFixed(1)}%.`, value: impactBps / 100 });
    return checks;
  }

  /** Turn a fresh quote into an order and the exact transaction for the wallet, simulated from that wallet first. */
  async order(accountId: string, wallet: Address, body: { quoteId: string; idempotencyKey: string; acknowledged: string[] }): Promise<{ order: TradeOrder; tx: UnsignedTx }> {
    const prior = this.d.db.prepare('SELECT * FROM orders WHERE account_id = ? AND idem = ?').get(accountId, body.idempotencyKey) as Record<string, unknown> | undefined;
    const q = this.quotes.get(body.quoteId);
    if (!q || this.now() > Date.parse(q.quote.expiresAt)) throw Object.assign(new Error('The quote expired. Get a new one.'), { code: 'quote_expired', status: 409 });
    if (q.quote.account && q.quote.account.toLowerCase() !== wallet.toLowerCase()) throw Object.assign(new Error('This quote was for another wallet.'), { code: 'forbidden', status: 403 });
    if (q.quote.guard.decision === 'refuse') throw Object.assign(new Error('EKO refuses this trade.'), { code: 'guard_refused', status: 409 });
    const warn = q.quote.guard.checks.filter(c => c.status === 'warn').map(c => c.code);
    if (warn.some(c => !body.acknowledged.includes(c))) throw Object.assign(new Error('Acknowledge the warnings first.'), { code: 'needs_ack', status: 409 });
    const deadline = BigInt(Math.floor(this.now() / 1000) + 300);
    const swap = buildSwap(q.key, q.quote.side, q.amountIn, q.minOut, wallet, deadline);
    // The exact call, from the wallet, now: it must not revert (the swap enforces the minimum out).
    try { await this.call(this.router, swap.data, 'latest', wallet, swap.value); }
    catch (error) {
      const msg = String((error as Error).message);
      const code = /insufficient funds|balance/i.test(msg) ? 'insufficient_balance' : /allowance|permit|TRANSFER_FROM|AllowanceExpired|InsufficientAllowance/i.test(msg) ? 'approval_required' : 'simulation_failed';
      throw Object.assign(new Error(code === 'insufficient_balance' ? 'Not enough HYPE in the wallet for this buy plus gas.' : code === 'approval_required' ? 'Approve the coin first.' : 'A simulation of this exact trade failed; it was not sent. Get a new quote.'), { code, status: 409 });
    }
    const t = Math.floor(this.now() / 1000);
    const id = prior ? String(prior.id) : `ord_${randomBytes(10).toString('hex')}`;
    if (!prior) this.d.db.prepare(`INSERT INTO orders(id, account_id, wallet, quote_id, idem, coin, side, amount_in, min_out, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, accountId, wallet.toLowerCase(), q.quote.id, body.idempotencyKey, q.quote.coin.toLowerCase(), q.quote.side, q.amountIn.toString(), q.minOut.toString(), 'awaiting_signature', t, t);
    return { order: this.get(accountId, id)!, tx: { chainId: CHAIN_ID, to: this.router, data: swap.data, value: swap.value.toString() } };
  }

  /** A quote's approvals as unsigned transactions (exact amounts; the Permit2 allowance expires with the quote's window). */
  approvalTxs(q: TradeQuote): UnsignedTx[] {
    return q.approvals.map(a => a.kind === 'erc20'
      ? { chainId: CHAIN_ID, to: a.token, value: '0', data: encodeFunctionData({ abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']), functionName: 'approve', args: [a.spender, BigInt(a.amount)] }) }
      : { chainId: CHAIN_ID, to: this.permit2, value: '0', data: encodeFunctionData({ abi: parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']), functionName: 'approve',
        args: [a.token, a.spender, BigInt(a.amount), a.expiration ?? Math.floor(this.now() / 1000) + 1500] }) });
  }

  get(accountId: string, id: string): TradeOrder | null {
    const r = this.d.db.prepare('SELECT * FROM orders WHERE id = ? AND account_id = ?').get(id, accountId) as Record<string, string | number | null> | undefined;
    return r ? toOrder(r) : null;
  }
  list(accountId: string): TradeOrder[] {
    return (this.d.db.prepare('SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC LIMIT 100').all(accountId) as Record<string, string | number | null>[]).map(toOrder);
  }
  submitted(accountId: string, id: string, txHash: string): TradeOrder | null {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw Object.assign(new Error('Bad transaction hash.'), { code: 'bad_request', status: 400 });
    this.d.db.prepare(`UPDATE orders SET status = 'submitted', tx_hash = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status IN ('awaiting_signature','submitted')`).run(txHash.toLowerCase(), Math.floor(this.now() / 1000), id, accountId);
    return this.emit(accountId, id);
  }
  rejected(accountId: string, id: string, code: string): TradeOrder | null {
    this.d.db.prepare(`UPDATE orders SET status = 'rejected', error_code = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status = 'awaiting_signature'`).run(code === 'user_rejected' ? code : 'signing_failed', Math.floor(this.now() / 1000), id, accountId);
    return this.emit(accountId, id);
  }
  private emit(accountId: string, id: string) { const o = this.get(accountId, id); if (o) this.d.onOrder?.(accountId, o); return o; }

  /** Settle submitted orders from their receipts; orders never sent expire. Run every few seconds. */
  async reconcile() {
    const t = Math.floor(this.now() / 1000);
    this.d.db.prepare(`UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'awaiting_signature' AND created_at < ?`).run(t, t - 600);
    const open = this.d.db.prepare(`SELECT * FROM orders WHERE status = 'submitted' AND tx_hash IS NOT NULL ORDER BY updated_at LIMIT 20`).all() as Record<string, string | number | null>[];
    for (const r of open) {
      const receipt = await this.d.rpc.request({ method: 'eth_getTransactionReceipt', params: [r.tx_hash] }).catch(() => null) as { status: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] } | null;
      if (!receipt) { if (Number(r.updated_at) < t - 900) this.d.db.prepare(`UPDATE orders SET status = 'failed', error_code = 'not_mined', updated_at = ? WHERE id = ?`).run(t, r.id); continue; }
      let filledIn: string | null = null, filledOut: string | null = null;
      const wallet = String(r.wallet), coin = String(r.coin);
      for (const l of receipt.logs) {
        if (l.topics[0] === TRANSFER_TOPIC && l.address.toLowerCase() === coin && l.topics.length === 3) {
          const from = `0x${l.topics[1]!.slice(26)}`, to = `0x${l.topics[2]!.slice(26)}`, v = BigInt(l.data.slice(0, 66)).toString();
          if (r.side === 'buy' && to === wallet) filledOut = v; if (r.side === 'sell' && from === wallet) filledIn = v;
        }
        if (l.address.toLowerCase() === this.d.registry.address('uniswapV4.poolManager').toLowerCase()) {
          try {
            const { args } = decodeEventLog({ abi: swapAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
            const hype = args.amount0 < 0n ? -args.amount0 : args.amount0;
            if (r.side === 'buy') filledIn = hype.toString(); else filledOut = hype.toString();
          } catch { /* not a Swap */ }
        }
      }
      const ok = receipt.status === '0x1';
      this.d.db.prepare(`UPDATE orders SET status = ?, filled_in = ?, filled_out = ?, error_code = ?, updated_at = ? WHERE id = ?`).run(ok ? 'confirmed' : 'failed', filledIn, filledOut, ok ? null : 'reverted', t, r.id);
      this.emit(String(r.account_id), String(r.id));
    }
  }
}

function toOrder(r: Record<string, string | number | null>): TradeOrder {
  return { id: String(r.id), quoteId: String(r.quote_id), status: r.status as TradeOrder['status'], coin: getAddress(String(r.coin)), side: r.side as 'buy' | 'sell', feeBps: 0,
    ...(r.tx_hash ? { txHash: String(r.tx_hash) } : {}), ...(r.filled_in ? { filledIn: String(r.filled_in) } : {}), ...(r.filled_out ? { filledOut: String(r.filled_out) } : {}),
    ...(r.error_code ? { errorCode: String(r.error_code) } : {}), createdAt: new Date(Number(r.created_at) * 1000).toISOString() };
}

/** The trade routes the web app's guarded flow calls (signed-in wallets only, except quotes). */
export function registerTradeRoutes(app: FastifyInstance, trading: Trading, auth: { account: (req: FastifyRequest) => { id: string; wallet: Address } | null }) {
  const send = (reply: FastifyReply, error: unknown) => {
    const e = error as { status?: number; code?: string; message?: string };
    return reply.code(e.status ?? 500).send({ error: e.code ?? 'internal_error', message: e.status ? e.message : 'Trading is unavailable right now.' });
  };
  app.post('/v1/trade/quote', async (req, reply) => {
    const parsed = TradeQuoteRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', message: 'Malformed quote request.' });
    const a = auth.account(req);
    try { return await trading.quote(parsed.data, a?.wallet ?? null); } catch (error) { return send(reply, error); }
  });
  app.post<{ Body: { quoteId?: unknown; idempotencyKey?: unknown; acknowledged?: unknown } }>('/v1/trade/order', async (req, reply) => {
    const a = auth.account(req);
    if (!a) return reply.code(401).send({ error: 'wallet_auth_required', message: 'Sign in with your wallet to trade.' });
    const b = req.body ?? {};
    if (typeof b.quoteId !== 'string' || typeof b.idempotencyKey !== 'string' || b.idempotencyKey.length > 80 || !Array.isArray(b.acknowledged) || !b.acknowledged.every(x => typeof x === 'string'))
      return reply.code(400).send({ error: 'bad_request', message: 'Malformed order.' });
    try { return await trading.order(a.id, a.wallet, { quoteId: b.quoteId, idempotencyKey: b.idempotencyKey, acknowledged: b.acknowledged as string[] }); } catch (error) { return send(reply, error); }
  });
  app.post<{ Params: { id: string }; Body: { txHash?: unknown } }>('/v1/trade/order/:id/submitted', async (req, reply) => {
    const a = auth.account(req);
    if (!a) return reply.code(401).send({ error: 'wallet_auth_required', message: 'Sign in with your wallet.' });
    try { return trading.submitted(a.id, req.params.id, String(req.body?.txHash ?? '')) ?? reply.code(404).send({ error: 'not_found', message: 'No such order.' }); } catch (error) { return send(reply, error); }
  });
  app.post<{ Params: { id: string }; Body: { code?: unknown } }>('/v1/trade/order/:id/rejected', async (req, reply) => {
    const a = auth.account(req);
    if (!a) return reply.code(401).send({ error: 'wallet_auth_required', message: 'Sign in with your wallet.' });
    return trading.rejected(a.id, req.params.id, String(req.body?.code ?? '')) ?? reply.code(404).send({ error: 'not_found', message: 'No such order.' });
  });
  app.get<{ Params: { id: string } }>('/v1/trade/orders/:id', async (req, reply) => {
    const a = auth.account(req);
    if (!a) return reply.code(401).send({ error: 'wallet_auth_required', message: 'Sign in with your wallet.' });
    return trading.get(a.id, req.params.id) ?? reply.code(404).send({ error: 'not_found', message: 'No such order.' });
  });
  app.get('/v1/trade/orders', async (req, reply) => {
    const a = auth.account(req);
    if (!a) return reply.code(401).send({ error: 'wallet_auth_required', message: 'Sign in with your wallet.' });
    return { rows: trading.list(a.id), cursor: null };
  });
}
