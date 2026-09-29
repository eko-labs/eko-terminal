import { afterEach, describe, expect, it } from 'vitest';
import { ChainDb } from '@eko/db';
import { historyPrunes } from '../src/history-prunes.js';
import { LiveActivity } from '../src/live-activity.js';
import { EngineWorker } from '../src/worker.js';
import { counting, liveHistory } from './live-history-fixture.js';

// A live poll must load into memory only what changed plus a fixed overhead (the coins active this week and eight days
// of block times), never the history: production ran out of an 8 GB heap reading every coin's activity and every block
// time on the first poll after a restart (2026-10-08). The same recent activity on top of one and of five times as much
// older history must return the same rows from the activity and planning reads, warm and in a new process.
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });

async function reads(scale: number) {
  const history = await liveHistory({ idleCoins: 40 * scale, idleTrades: 150, activeCoins: 4 }); handles.push(history.db);
  let now = history.now;
  const head = async () => Number((await history.db.sql.query<{ n: string }>('SELECT max(number)::text AS n FROM engine_block_times')).rows[0]!.n);
  // A live poll writes the active coins' progress; the first start ever also fills missing block times everywhere once.
  await new EngineWorker(history.db, { now: () => now, liveBacklogSec: 900 }).poll();
  const counted = counting(history.db);
  // Activity and plans of one poll, as EngineWorker reads them, counting the rows returned.
  const poll = async (live: LiveActivity, to: number) => {
    counted.count.rows = 0;
    const loaded = (await live.refresh(to, now, await historyPrunes(counted.db), { cache: new Map(), concurrency: 4, stopped: () => false }))!;
    const through = new Map((await history.db.sql.query<{ coin: Uint8Array; through_block: string }>('SELECT coin,through_block FROM engine_activity_state')).rows
      .map(row => [`0x${Buffer.from(row.coin).toString('hex')}`, Number(row.through_block)]));
    const plans = await live.plans(loaded.coins.map(coin => ({ coin: coin.coin, from: (through.get(coin.coin) ?? -1) + 1 })), to);
    return { rows: counted.count.rows, stats: { ...live.stats!, ms: 0, sumMs: 0, clockMs: 0 }, coins: loaded.coins.length, tasks: [...plans.values()].flat().length };
  };
  const warm = new LiveActivity(counted.db);
  await poll(warm, await head());
  now += 120; await history.trade(1, now - 60); await history.trade(2, now - 30);
  const warmPoll = await poll(warm, await head());
  now += 120; await history.trade(3, now - 60);
  const restarted = await poll(new LiveActivity(counted.db), await head());
  return { history: await history.rows(), warm: warmPoll, restarted };
}

describe('live poll memory bound', () => {
  it('reads the same rows whatever the size of the older history, warm and in a new process', async () => {
    const small = await reads(1), large = await reads(5);
    expect(large.history).toBeGreaterThan(3 * small.history);
    expect(large.warm).toEqual(small.warm);
    expect(large.restarted).toEqual(small.restarted);
    expect(large.warm.stats).toMatchObject({ cold: false, summedCoins: 0, rangeRows: 0, coins: 4 });
    expect(large.restarted.stats).toMatchObject({ cold: true, summedCoins: 0, rangeRows: 0, coins: 4 });
    // Rows read are a small fraction of the history even for the smaller one.
    expect(small.restarted.rows * 20).toBeLessThan(small.history);
  }, 240_000);
});
