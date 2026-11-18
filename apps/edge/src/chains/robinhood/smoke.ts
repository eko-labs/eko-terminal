/**
 * Live read-only smoke check (not a CI test): tails about 30 minutes of Robinhood Chain logs over the public RPC through
 * the decoders, prints the coins found, then runs EthUsd and one probe (eth_call only, nothing is signed or sent).
 *   cd apps/edge && node --import tsx src/chains/robinhood/smoke.ts [minutes]
 */
import { loadRegistry } from '@eko/chain';
import { toFunctionSelector, type Address, type Hex } from 'viem';
import type { RawLog, Rpc } from '../../tracker.js';
import { robinhoodAddresses } from './addresses.js';
import { applyRobinhoodEvent, decodeRobinhoodLog, orderRobinhoodLogs, robinhoodLogQueries, type RobinhoodCoinState, type RobinhoodEvent } from './events.js';
import { EthUsd } from './price.js';
import { probeRobinhoodCoin } from './probe.js';
import { ROBINHOOD_PROFILE } from './profile.js';
import { curveProgressBps } from './progress.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let calls = 0;
/** The public RPC with backoff on 429. */
const rpc: Rpc = { async request({ method, params }) {
  for (let attempt = 0; ; attempt++) {
    calls++;
    const res = await fetch(ROBINHOOD_PROFILE.publicRpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }) });
    const body = await res.json().catch(() => ({ error: { code: res.status, message: res.statusText } })) as { result?: unknown; error?: { code: number; message: string } };
    if ((res.status === 429 || body.error?.code === 429) && attempt < 8) { await sleep(500 * 2 ** Math.min(attempt, 4)); continue; }
    if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
    return body.result;
  }
} };
const hex = (n: bigint) => `0x${n.toString(16)}`;

async function logs(filter: { address?: Address | Address[]; topics: (Hex | Hex[] | null)[] }, from: bigint, to: bigint, span: bigint): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let start = from; start <= to;) {
    const end = start + span - 1n < to ? start + span - 1n : to;
    try {
      out.push(...await rpc.request({ method: 'eth_getLogs', params: [{ ...filter, fromBlock: hex(start), toBlock: hex(end) }] }) as RawLog[]);
      start = end + 1n;
    } catch (error) {
      if (span > 50n && /limit|too many|exceed|range/i.test(String(error))) { span /= 2n; continue; }
      throw error;
    }
  }
  return out;
}

const minutes = Number(process.argv[2] ?? 30);
const addrs = robinhoodAddresses(loadRegistry());
const head = BigInt(await rpc.request({ method: 'eth_blockNumber', params: [] }) as Hex);
const from = head - BigInt(Math.round(minutes * 60 / ROBINHOOD_PROFILE.blockTimeSec));
const [tradesQ, initQ] = robinhoodLogQueries(addrs);
const t0 = Date.now();
const raw = [...await logs(tradesQ!, from, head, 10_000n), ...await logs(initQ!, from, head, 1_000_000n)];
console.log(`blocks ${from}..${head} (${head - from} blocks, ~${minutes} min): ${raw.length} logs in ${Date.now() - t0} ms`);

const coins = new Map<string, RobinhoodCoinState>(), curves = new Map<string, Address>();
const counts: Record<string, number> = {};
let orphanTrades = 0, orphanGrads = 0, tokenQuoted = 0;
for (const log of orderRobinhoodLogs(raw)) {
  const e: RobinhoodEvent | null = decodeRobinhoodLog(log, addrs, c => curves.get(c.toLowerCase()) ?? null);
  if (!e) { if (log.topics[0] === tradesQ!.topics[0]![0] && log.address.toLowerCase() === addrs.factory.toLowerCase()) tokenQuoted++; else if (log.topics[0] !== tradesQ!.topics[0]![0] && log.topics[0] !== initQ!.topics[0]) orphanTrades++; continue; }
  counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  // A liquidity change names a pool, not a coin; this smoke check follows coins by token.
  if (e.kind === 'liquidity') continue;
  const token = e.kind === 'curve_trade' ? e.token! : e.token;
  const next = applyRobinhoodEvent(coins.get(token.toLowerCase()), e, { addrs });
  if (!next) { if (e.kind === 'graduated') orphanGrads++; continue; }
  coins.set(next.token.toLowerCase(), next);
  if (next.curve) curves.set(next.curve.address.toLowerCase(), next.token);
}
console.log('decoded', counts, `| token-quoted launches skipped ${tokenQuoted} | trades on curves launched before the window ${orphanTrades} | graduations of older coins ${orphanGrads}`);
const list = [...coins.values()].sort((a, b) => b.trades.length - a.trades.length);
console.log(`coins launched in the window: ${list.length}, graduated: ${list.filter(c => c.graduated).length}, with trades: ${list.filter(c => c.trades.length).length}`);
for (const c of list.slice(0, 12)) {
  console.log(`  ${c.token} block ${c.block} trades ${String(c.trades.length).padStart(3)} net ${c.netHype.toFixed(4)} ETH progress ${curveProgressBps(c.curve!, c.graduated)} bps${c.graduated ? ` graduated pool ${c.poolId.slice(0, 10)}…` : ''}`);
}

// The reserves rebuilt from logs against the curves' own getters at the same block (the window's last).
let agree = 0;
const curveRead = async (curve: Address, data: Hex) => BigInt(await rpc.request({ method: 'eth_call', params: [{ to: curve, data }, hex(head)] }) as Hex);
for (const c of list.filter(c => c.curve && !c.graduated)) {
  const [q, t] = [await curveRead(c.curve!.address, toFunctionSelector('realQuoteReserve()')), await curveRead(c.curve!.address, toFunctionSelector('sellableTokens()'))];
  if (q === c.curve!.realQuoteReserve && t === c.curve!.realTokenReserve) agree++;
  else console.log(`  reserves differ for ${c.token}: tracked ${c.curve!.realQuoteReserve}/${c.curve!.realTokenReserve}, chain ${q}/${t}`);
}
console.log(`curve reserves rebuilt from logs equal the chain's getters for ${agree} of ${list.filter(c => c.curve && !c.graduated).length} coins`);

const ethUsd = new EthUsd({ rpc });
console.log('ETH/USD', await ethUsd.get(), ethUsd.lastRefusal ? `refused ${JSON.stringify(ethUsd.lastRefusal)}` : '');
// One probe on the busiest coin still on its curve, at the head (the public RPC keeps ~6,000 blocks of state).
const target = list.find(c => !c.graduated && c.trades.length);
if (target) {
  const block = BigInt(await rpc.request({ method: 'eth_blockNumber', params: [] }) as Hex);
  const p = await probeRobinhoodCoin(target, block, { rpc, addrs, ethUsd: () => ethUsd.latest });
  console.log('probe', target.token, { name: p.name, symbol: p.symbol, taxPct: p.taxPct, pons: p.pons && { ...p.pons, realQuoteReserve: String(p.pons.realQuoteReserve), realTokenReserve: String(p.pons.realTokenReserve) },
    tracked: { realQuoteReserve: String(target.curve!.realQuoteReserve), realTokenReserve: String(target.curve!.realTokenReserve) },
    probe: p.probe && { venue: p.probe.venue, status: p.probe.status, reason: p.probe.reason, sizeWei: p.probe.sizeWei, exitCostPct: p.probe.exitCostPct } });
}
const grad = list.find(c => c.graduated);
if (grad) {
  const block = BigInt(await rpc.request({ method: 'eth_blockNumber', params: [] }) as Hex);
  const p = await probeRobinhoodCoin(grad, block, { rpc, addrs, ethUsd: () => ethUsd.latest });
  console.log('probe graduated', grad.token, { lock: p.lock, probe: p.probe && { venue: p.probe.venue, status: p.probe.status, exitCostPct: p.probe.exitCostPct } });
}
// Transfer density, for the tracker's span.
const tb = 200n, transfers = await logs({ topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] }, head - tb + 1n, head, tb);
console.log(`ERC-20/721 Transfer logs: ${(transfers.length / Number(tb)).toFixed(1)} a block over the last ${tb} blocks; ${calls} RPC calls in all`);
