/**
 * EKO starter agent: a small, dry-run trading agent that talks to EKO's MCP server.
 *
 * It waits for news with `watch` (no polling), keeps coins whose EKO score and verdict pass your bar, asks EKO's
 * `preflight` before every would-be buy, prepares the trade with `trade_prepare` when preflight allows it, and writes
 * its reasoning to your Mission Control journal, where you watch it live.
 *
 * It NEVER signs or sends anything. There is no private key in this program, and EKO never holds keys: a prepared trade
 * is an unsigned transaction for the wallet you set for this agent in Mission Control. See README.md for how a person
 * would add their own signing.
 *
 * Run:  EKO_KEY=eko_your_key_here npx tsx agent.ts      (or: node agent.ts on Node 23.6+, which runs TypeScript)
 * Env:  EKO_KEY (required), EKO_MCP_URL (default https://ekoterminal.com/mcp), MIN_SCORE (default 70),
 *       BUY_USD (default 25), MAX_AGE_MIN (default 60), ONCE=1 (one pass, then exit).
 * No dependencies: Node 18+ fetch only.
 */

const KEY = process.env.EKO_KEY ?? '';
const URL_ = process.env.EKO_MCP_URL ?? 'https://ekoterminal.com/mcp';
const MIN_SCORE = Number(process.env.MIN_SCORE ?? 70);
const BUY_USD = Number(process.env.BUY_USD ?? 25);
const MAX_AGE_MIN = Number(process.env.MAX_AGE_MIN ?? 60);
const ONCE = process.env.ONCE === '1';

interface Untrusted { text: string; flags: string[] }
interface Score { value: number; band: string; label?: string; cappedBy?: string }
interface CoinRow { address: string; symbol: Untrusted; launchpad: string; verdict: string; score: Score | null; liquidityUsd: number; ageMin: number }
interface WatchEvent { cursor: string; kind: string; coin: string; symbol?: Untrusted; verdict?: string; score?: number; band?: string; title: string }

let rpcId = 0;
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const ticker = (s?: Untrusted) => s?.text ? `$${s.text}` : 'a coin';

/** One MCP tool call (JSON-RPC over streamable HTTP). Tool errors come back as { error } instead of throwing. */
async function tool<T>(name: string, args: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (res.status === 429 && attempt < 3) { await sleep(15_000); continue; }
    if (res.status === 401) throw new Error('EKO refused the key (unknown or revoked). Create a new one in Mission Control.');
    if (!res.ok) throw new Error(`EKO answered HTTP ${res.status}`);
    const body = await res.json() as { result?: { isError?: boolean; content?: { text: string }[]; structuredContent?: T }; error?: { message: string } };
    if (body.error) return { ok: false, error: body.error.message };
    if (body.result?.isError) return { ok: false, error: body.result.content?.[0]?.text ?? 'tool error' };
    return { ok: true, data: body.result!.structuredContent as T };
  }
}

/** A line for your Mission Control journal (you see it live on the agent's page). */
async function note(text: string) {
  const r = await tool('journal', { kind: 'note', payload: { text: text.slice(0, 280) } });
  if (!r.ok) console.log(`  (journal: ${r.error})`);
}

/** Does this coin pass the bar? EKO's verdict must be clear and its score at least MIN_SCORE. */
function passes(verdict: string | undefined, score: number | undefined): string | null {
  if (verdict !== 'clear') return `verdict is ${verdict ?? 'pending'}`;
  if (score === undefined || score < MIN_SCORE) return `score ${score ?? 'none'} is under ${MIN_SCORE}`;
  return null;
}

const looked = new Set<string>();

/** Check one coin, ask preflight, prepare the trade if allowed. Never signs. */
async function consider(coin: string, symbol?: Untrusted) {
  const key = coin.toLowerCase();
  if (looked.has(key)) return;
  looked.add(key);
  const v = await tool<{ level: string; reasons: string[]; ekoScore: Score | null }>('coin_verdict', { coin });
  if (!v.ok) { console.log(`  skip ${ticker(symbol)}: ${v.error}`); return; }
  const why = passes(v.data.level, v.data.ekoScore?.value);
  if (why) { console.log(`  skip ${ticker(symbol)}: ${why}`); return; }
  const scoreText = `score ${v.data.ekoScore!.value} (${v.data.ekoScore!.label ?? v.data.ekoScore!.band})`;
  console.log(`  ${ticker(symbol)} passes: clear, ${scoreText}. Asking preflight for a $${BUY_USD} buy.`);
  const ref = `starter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const pf = await tool<{ decision: string; reasons: string[] }>('preflight', { clientOrderRef: ref, coin, side: 'buy', notionalUsd: BUY_USD });
  if (!pf.ok) { await note(`Wanted ${ticker(symbol)} (${scoreText}) but preflight failed: ${pf.error}`); return; }
  if (pf.data.decision !== 'allow') {
    await note(`Skipped ${ticker(symbol)}: preflight said ${pf.data.decision}. ${pf.data.reasons.slice(0, 2).join(' ')}`);
    console.log(`  preflight: ${pf.data.decision}`);
    return;
  }
  const prep = await tool<{ status: string; tx?: { to: string; value: string; data: string }; quote?: { amountIn: string; minOut: string } }>('trade_prepare',
    { preflightClientOrderRef: ref, coin, side: 'buy', amountUsd: BUY_USD, slippageBps: 300 });
  if (!prep.ok) { await note(`Preflight allowed ${ticker(symbol)}, but no trade was prepared: ${prep.error}`); console.log(`  trade_prepare: ${prep.error}`); return; }
  // DRY RUN: the unsigned transaction is printed and dropped. Nothing is signed or sent.
  console.log(`  prepared (unsigned, NOT sent): to ${prep.data.tx?.to} value ${prep.data.tx?.value} wei, min out ${prep.data.quote?.minOut}`);
  await note(`Would buy $${BUY_USD} of ${ticker(symbol)}: clear, ${scoreText}, preflight allowed. Dry run: the unsigned trade was not signed or sent.`);
}

async function main() {
  if (!/^eko_[A-Za-z0-9_-]{10,}$/.test(KEY)) {
    console.error('Set EKO_KEY to the agent key Mission Control showed you once (it starts with eko_). Example: EKO_KEY=eko_your_key_here npx tsx agent.ts');
    process.exit(1);
  }
  console.log(`EKO starter agent (dry run) on ${URL_}: buys nothing, signs nothing. Bar: clear and score >= ${MIN_SCORE}, $${BUY_USD} a buy.`);
  await tool('journal', { kind: 'session_start', payload: { text: `Starter agent online (dry run): clear coins scoring ${MIN_SCORE}+, $${BUY_USD} each.` } });

  // Coins already listed that pass the bar.
  const seed = await tool<{ coins: CoinRow[] }>('coins', { verdict: 'clear', minScore: MIN_SCORE, maxAgeMin: MAX_AGE_MIN, sort: 'score', limit: 5 });
  if (seed.ok) for (const c of seed.data.coins) await consider(c.address, c.symbol);
  else console.log(`coins: ${seed.error}`);
  if (ONCE) return;

  // Then wait for news: new launches are pending at first, so act when a verdict arrives.
  let cursor: string | undefined;
  let stop = false;
  process.on('SIGINT', () => { stop = true; console.log('\nStopping after this wait.'); });
  while (!stop) {
    const w = await tool<{ events: WatchEvent[]; cursor: string; reset?: boolean }>('watch', { ...(cursor ? { cursor } : {}), kinds: ['launch', 'verdict'], waitSec: 25 });
    if (!w.ok) { console.log(`watch: ${w.error}`); await sleep(5_000); continue; }
    if (w.data.reset) console.log('EKO restarted; some events may have been missed.');
    cursor = w.data.cursor;
    for (const e of w.data.events) {
      console.log(`${e.kind}: ${ticker(e.symbol)} ${e.title}${e.score !== undefined ? ` · score ${e.score}` : ''}`);
      if (e.kind === 'verdict' && !passes(e.verdict, e.score)) await consider(e.coin, e.symbol);
    }
  }
  await tool('journal', { kind: 'note', payload: { text: 'Starter agent stopped.' } });
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
