import { afterEach, describe, expect, it } from 'vitest';
import { ChainDb, migrate, migrateEngines, rebuildBalances, type SqlClient } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { refreshClock } from '../src/activity.js';
import { OUTCOME_LOADS_PER_WRITE, updateOutcomes } from '../src/outcomes.js';
import { EngineWorker, type EvaluationProgress } from '../src/worker.js';

// After an outage, every launch whose 1h/24h horizons passed without an outcome was evaluated inside the first card's
// write transaction (production 2026-10-09: about 34,000 coins). No card committed for hours and nothing was logged.
// Outcome catch-up is now a few horizons per write, and the evaluation phase reports progress while it runs.
const epoch = Date.parse('2026-09-01T00:00:00Z') / 1000, B0 = 7_000_000, LAUNCHES = 40;
const block = (sec: number) => B0 + Math.floor((sec - epoch) / 2);
const now = epoch + 3 * 86400;
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });

/** LAUNCHES coins launched two days before `now` that traded in their first hour, and one launched a minute before. */
async function backlog() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(epoch * 1000));
  await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,launchpad,decimals,total_supply,supply_block,first_block,block)
    SELECT decode(lpad(to_hex(1000+c),40,'0'),'hex'),decode(lpad(to_hex(900000+c),40,'0'),'hex'),'Sample coin','DEMO','other',0,1000000000,b,b,b
    FROM generate_series(1,$1::int+1) c CROSS JOIN LATERAL (SELECT $2::bigint+CASE WHEN c<=$1::int THEN (86400+c*60)/2 ELSE (3*86400-60)/2 END AS b) x`, [LAUNCHES, B0]);
  await db.sql.query(`CREATE TEMP TABLE t AS SELECT c,j,CASE WHEN c<=$1::int THEN 86400+c*60+60+j*600 ELSE 3*86400-30 END AS sec
    FROM generate_series(1,$1::int+1) c CROSS JOIN generate_series(0,3) j WHERE c<=$1::int OR j=0`, [LAUNCHES]);
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,side,amount_coin,amount_quote,price_quote,usd,priced_block)
    SELECT to_timestamp($1::bigint+sec),$2::bigint+sec/2,decode(lpad(to_hex(c*100+j),64,'0'),'hex'),0,'uniswap_v3',decode(lpad(to_hex(500000+c),40,'0'),'hex'),
      decode(lpad(to_hex(1000+c),40,'0'),'hex'),decode(repeat('00',20),'hex'),w,w,decode(lpad(to_hex(500000+c),40,'0'),'hex'),CASE WHEN j%2=0 THEN 1 ELSE -1 END,100,100,1+j*0.1,25+j,$2::bigint+sec/2
    FROM t CROSS JOIN LATERAL (SELECT decode(lpad(to_hex(2000000+c*10+j),40,'0'),'hex') AS w) x`, [epoch, B0]);
  await db.sql.query(`INSERT INTO token_transfers(ts,block,tx_hash,log_index,token,from_address,to_address,amount) SELECT to_timestamp($1::bigint+sec),$2::bigint+sec/2,
    decode(lpad(to_hex(c*100+j),64,'0'),'hex'),1,decode(lpad(to_hex(1000+c),40,'0'),'hex'),decode(lpad(to_hex(500000+c),40,'0'),'hex'),decode(lpad(to_hex(2000000+c*10+j),40,'0'),'hex'),100 FROM t`, [epoch, B0]);
  await db.sql.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts) SELECT b,b,decode(lpad(to_hex(b),64,'0'),'hex'),decode(lpad(to_hex(b-1),64,'0'),'hex'),to_timestamp($1::bigint+(b-$2::bigint)*2)
    FROM (SELECT DISTINCT $2::bigint+sec/2 AS b FROM t UNION SELECT first_block FROM tokens UNION SELECT $2::bigint+(3*86400-10)/2) x ON CONFLICT DO NOTHING`, [epoch, B0]);
  await db.sql.query('DROP TABLE t');
  await db.tx(tx => rebuildBalances(tx));
  return db;
}
const outcomes = async (db: ChainDb) => (await db.sql.query<{ row: string }>("SELECT concat_ws(':',encode(coin,'hex'),horizon,outcome) AS row FROM outcomes ORDER BY 1")).rows.map(r => r.row);

describe('live outcome catch-up', () => {
  it('commits the first card after a bounded number of outcome evaluations and catches up over later writes', async () => {
    const db = await backlog(), reference = await backlog();
    // A non-launchpad token (no deployer, as WETH) launched with the backlog never loads sources, so it is never due.
    const junk = Buffer.from('ab'.repeat(20), 'hex');
    await db.sql.query("INSERT INTO tokens(address,name,symbol,decimals,first_block,block) VALUES($1,'Wrapped sample','WSAMPLE',18,$2,$2)", [junk, B0 + (86400 + 60) / 2]);
    // Count outcome inserts until the first card commits, and reads of the due launches.
    let cardAt: number | undefined, inserts = 0, dueReads = 0;
    const wrap = (sql: SqlClient): SqlClient => ({ query: async <T,>(text: string, params?: unknown[]) => {
      if (text.startsWith('INSERT INTO outcomes')) inserts++;
      if (text.includes('AS done FROM tokens t')) dueReads++;
      if (text.startsWith('INSERT INTO engine_runs') && cardAt === undefined) cardAt = inserts;
      return sql.query<T>(text, params);
    } });
    const traced = new ChainDb(wrap(db.sql), fn => db.tx(tx => fn(wrap(tx.sql))));
    const reports: EvaluationProgress[] = [];
    const worker = new EngineWorker(traced, { now: () => now, liveBacklogSec: 900, onEvaluation: progress => reports.push(progress) });
    expect(await worker.poll()).toBeGreaterThan(0);
    expect(cardAt).toBeDefined();
    expect(cardAt!).toBeLessThanOrEqual(OUTCOME_LOADS_PER_WRITE);
    // One read of the due launches serves the poll's writes until a call has tried them all (it read every launch per write).
    const runs = Number((await db.sql.query<{ n: string }>('SELECT count(*)::text AS n FROM engine_runs')).rows[0]!.n);
    expect(runs).toBeGreaterThan(10);
    expect(dueReads).toBeLessThanOrEqual(2);
    // Later polls finish the catch-up; the outcomes equal one unbounded pass over the same rows.
    for (let poll = 0; poll < 40 && reports.at(-1)!.outcomesPending; poll++) await worker.poll();
    expect(reports.at(-1)).toMatchObject({ phase: 'done', outcomesPending: false });
    const to = Number((await db.sql.query<{ n: string }>('SELECT max(number)::text AS n FROM engine_block_times')).rows[0]!.n);
    await refreshClock(reference);
    await updateOutcomes(reference, to, now, undefined, undefined, new Map());
    const expected = await outcomes(reference);
    expect(expected.length).toBeGreaterThanOrEqual(LAUNCHES);
    expect(await outcomes(db)).toEqual(expected);
    expect((await db.sql.query('SELECT 1 FROM engine_card_failures WHERE coin=$1', [junk])).rows).toHaveLength(0);
  }, 120_000);

  it('reports the evaluation phase while no card has completed yet', async () => {
    const db = await backlog();
    const reports: EvaluationProgress[] = [];
    let completions = 0;
    const worker = new EngineWorker(db, { now: () => now, liveBacklogSec: 900, evaluationReportMs: 20, onProgress: () => { completions++; },
      onEvaluation: progress => reports.push({ ...progress, completed: Math.min(progress.completed, completions) }),
      // A slow acquisition step: the first cards take longer than several report intervals.
      referenceSimulation: () => new Promise(resolve => setTimeout(resolve, 150)) });
    const completed = await worker.poll();
    expect(reports.some(report => report.phase !== 'done' && report.completed === 0 && report.attempted > 0)).toBe(true);
    expect(reports.at(-1)).toMatchObject({ phase: 'done', completed });
    expect(reports.at(-1)!.attempted).toBe(reports.at(-1)!.skipped + reports.at(-1)!.failed + completed);
  }, 120_000);
});
