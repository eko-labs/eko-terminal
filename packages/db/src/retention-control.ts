import { retentionPhase } from './retention-errors.js';
import { ChainDb, type SqlClient } from './client.js';
import type { RetentionOptions, RetentionResult } from './retention.js';

export async function retentionLimits(db: ChainDb) {
  await db.sql.query("SET LOCAL statement_timeout='1s'");
  await db.sql.query("SET LOCAL lock_timeout='1s'");
  await db.sql.query('SET LOCAL max_parallel_workers_per_gather=0');
  // Candidate windows and correlated probes have indexes. Avoid a large sequential scan chosen on stale statistics.
  await db.sql.query('SET LOCAL enable_seqscan=off');
  await db.sql.query('SET LOCAL enable_hashjoin=off');
  await db.sql.query('SET LOCAL enable_mergejoin=off');
}

/** Direct reads also get transaction-local limits, without enabling deletion triggers. */
export function retentionDb(db: ChainDb, deadline: number | (() => number) = Date.now() + 115_000, statementMs: () => number = () => 1_000): ChainDb {
  const transaction = <T>(work: (tx: ChainDb) => Promise<T>) => db.tx(async tx => {
    await retentionLimits(tx);
    const sql: SqlClient = { query: async (text, params) => {
      const remaining = Math.min(statementMs(), (typeof deadline === 'function' ? deadline() : deadline) - Date.now());
      if (remaining <= 0) throw Object.assign(new Error('Retention pass deadline reached'), { code: '57014' });
      // Recheck before every statement in multi-statement batches, including nested compaction transactions.
      await tx.sql.query(`SET LOCAL statement_timeout='${remaining}ms'`);
      return tx.sql.query(text, params);
    } };
    return work(new ChainDb(sql, nested => nested(sql)));
  });
  return new ChainDb({ query: (sql, params) => transaction(tx => tx.sql.query(sql, params)) },
    work => transaction(tx => work(tx.sql)));
}

export type RetentionRuleRunner = (name: string, work: (timeLeft: () => boolean, batchRows: number) => Promise<void>) => Promise<void>;
export interface RetentionBatchState { rows: number; successes: number; ceiling?: number }
const batches = new WeakMap<ChainDb, Map<string, RetentionBatchState>>();
export function retentionBatchSizes(db: ChainDb) {
  let state = batches.get(db);
  if (!state) { state = new Map(); batches.set(db, state); }
  return state;
}
const removedRows = (r: RetentionResult) => r.quoteRows+r.idleRows+r.pendingRows+r.feedRows+r.historyTransfers+r.historyLiquidity+r.historyPons+r.historySwaps+
  Object.values(r.ratingRows ?? {}).reduce((sum, n) => sum+n, 0);
export function retentionRules(options: RetentionOptions, result: RetentionResult, startDeadline: (budget: number) => void = () => {},
  sizes = new Map<string, RetentionBatchState>()): RetentionRuleRunner {
  const now = options.now ?? Date.now, passStarted = now();
  const passBudget = Math.min(options.passBudgetMs ?? 115_000, 115_000);
  const maxBatchRows = Math.max(1, Math.min(options.batchRows ?? 1000, 5000));
  return async (name, work) => {
    const started = now(), before = removedRows(result);
    const ceiling = name === 'receipt_publications' ? Math.min(maxBatchRows,64) : maxBatchRows, floor = Math.min(32,ceiling);
    // Initial immutable per-coin snapshots and hourly rankings are aggregates, not LIMIT-sized deletes.
    const budget = options.budgetMs ?? (name === 'receipt_publications' ? 30_000 : 6_000);
    const timeLeft = () => { const current = now(); return current - started < budget && current - passStarted < passBudget; };
    const state = sizes.get(name) ?? { rows: ceiling, successes: 0 };
    if (state.ceiling !== undefined && state.ceiling !== ceiling) { state.rows = ceiling; state.successes = 0; }
    state.ceiling = ceiling; state.rows = Math.min(state.rows, ceiling); sizes.set(name, state);
    const stats = (result.ruleStats ??= {})[name] = { rows: 0, skipped: 0, timeouts: 0, batchRows: state.rows };
    // Retries share the original rule and pass deadlines. Every failed transaction has rolled back first.
    startDeadline(Math.max(1_000, budget));
    let succeeded = false;
    while (timeLeft()) {
      try { await work(timeLeft, state.rows); succeeded = true; break; }
      catch (error) {
        const code = (error as { code?: string })?.code;
        if (code !== '55P03' && code !== '57014') await retentionPhase(name, async () => { throw error; });
        state.successes = 0;
        if (code === '57014') {
          stats.timeouts++;
          if (state.rows > floor) { state.rows = Math.max(floor, Math.floor(state.rows/2)); continue; }
        }
        break;
      }
    }
    if (!succeeded) {
      result.finished = false; stats.skipped++;
      if (!result.skippedRules.includes(name)) result.skippedRules.push(name);
    } else if (!stats.timeouts && ++state.successes >= 4) {
      state.rows = Math.min(ceiling, state.rows+Math.max(1, Math.floor(state.rows/10))); state.successes = 0;
    }
    stats.rows = removedRows(result)-before; stats.batchRows = state.rows;
    if (!timeLeft()) result.finished = false;
  };
}

/** Resume candidate walks across passes, including prefixes made entirely of retained rows. No row data is logged. */
const cursors = new WeakMap<ChainDb, Map<string, unknown[]>>();
export function retentionCursors(db: ChainDb) {
  let map = cursors.get(db);
  if (!map) { map = new Map(); cursors.set(db, map); }
  return map;
}
