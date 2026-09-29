// Offline live-poll cost benchmark: the activity and planning reads of one live poll over the same recent activity on
// top of growing older history, read in full (coinActivity plus every block time, as live polls did until 2026-10-08,
// and as ENGINE_LIVE_ACTIVITY=full still does) and incrementally (LiveActivity), warm and in a new process. Reports wall
// time and rows returned (what the poll holds in memory). PGlite, no network; BENCH_SCALES resizes the older history.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { coinActivity } from '../src/activity.js';
import { historyPrunes } from '../src/history-prunes.js';
import { LiveActivity } from '../src/live-activity.js';
import { EngineWorker } from '../src/worker.js';
import { counting, liveHistory } from './live-history-fixture.js';

const scales = (process.env.BENCH_SCALES ?? '1,4,16').split(',').map(Number);
const results = [];
for (const scale of scales) {
  const history = await liveHistory({ idleCoins: 50 * scale, idleTrades: 200, activeCoins: 6 });
  try {
    let now = history.now;
    const head = async () => Number((await history.db.sql.query<{ n: string }>('SELECT max(number)::text AS n FROM engine_block_times')).rows[0]!.n);
    // One live poll writes every active coin's progress, as a running engine would have.
    await new EngineWorker(history.db, { now: () => now, liveBacklogSec: 900 }).poll();
    const counted = counting(history.db);
    const measure = async (read: () => Promise<unknown>) => {
      counted.count.rows = 0; counted.count.queries = 0;
      const start = performance.now();
      await read();
      return { ms: Math.round(performance.now() - start), rows: counted.count.rows, queries: counted.count.queries };
    };
    const plan = async (live: LiveActivity, to: number) => {
      const loaded = (await live.refresh(to, now, await historyPrunes(counted.db), { cache: new Map(), concurrency: 4, stopped: () => false }))!;
      const through = new Map((await counted.db.sql.query<{ coin: Uint8Array; through_block: string }>('SELECT coin,through_block FROM engine_activity_state WHERE coin=ANY($1)',
        [loaded.coins.map(coin => Buffer.from(coin.coin.slice(2), 'hex'))])).rows.map(row => [`0x${Buffer.from(row.coin).toString('hex')}`, Number(row.through_block)]));
      await live.plans(loaded.coins.map(coin => ({ coin: coin.coin, from: (through.get(coin.coin) ?? -1) + 1 })), to);
    };
    const warm = new LiveActivity(counted.db);
    await plan(warm, await head());
    for (let i = 1; i <= 6; i++) { now += 60; await history.trade(i, now - 30); }
    const to = await head();
    const incremental = await measure(() => plan(warm, to));
    const restarted = await measure(() => plan(new LiveActivity(counted.db), to));
    const full = await measure(async () => {
      await coinActivity(counted.db, to, undefined, new Map());
      await counted.db.sql.query('SELECT number,ts FROM engine_block_times WHERE number<=$1 ORDER BY number', [to]);
    });
    results.push({ scale, historyRows: await history.rows(), full, incremental, restarted });
  } finally { await history.db.close(); }
}
for (const result of results) console.log(JSON.stringify(result));
console.log('| older history | history rows | full read ms / rows | incremental warm ms / rows | new process ms / rows |\n| ---: | ---: | ---: | ---: | ---: |');
for (const r of results) console.log(`| ${r.scale}x | ${r.historyRows} | ${r.full.ms} / ${r.full.rows} | ${r.incremental.ms} / ${r.incremental.rows} | ${r.restarted.ms} / ${r.restarted.rows} |`);
const [first, last] = [results[0]!, results.at(-1)!];
assert.equal(last.incremental.rows, first.incremental.rows, 'A warm incremental poll must read the same rows whatever the older history');
assert.equal(last.restarted.rows, first.restarted.rows, 'A new process must read the same rows whatever the older history');
assert.ok(scales.length < 2 || last.full.rows > 4 * first.full.rows, 'The full read grows with the history');
