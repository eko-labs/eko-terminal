import { keccak256, stringToHex } from 'viem';
import { canonicalize, PersonaVoteSchema, type PersonaVote } from '@eko/shared';
import { currentReceiptAnchor, hex, type ChainDb } from '@eko/db';
import { calibrationReport, fitMomentum, momentumProbability, type CalibrationRow, type MomentumExample, type MomentumModel, SWARM_WEEK_MS } from '@eko/engines';
import type { PonsResult, ReferenceResult } from '@eko/chain';
import { initialPaperPosition, paperExitReason, referencePaperLeg, stepPaper, type PaperPosition } from './paper.js';
import { SwarmCalibrationInputSchema, SwarmCalibrationCohortSchema, type SwarmCalibrationCohort, SwarmOutcomeSchema, SwarmPaperTickSchema, type SwarmCalibrationInput, type SwarmOutcome, type SwarmPaperTick } from './source.js';

const digest = (value: unknown) => keccak256(stringToHex(canonicalize(value)));
interface Forecast {
  id: string; coin: string; as_of_block: string; recorded_at: Date; data: { apeShare: number };
  payload: { deterministicInput: { evidence?: 'fixture' | 'live'; samples: { vote: PersonaVote }[] } };
}
interface Outcome { input: SwarmOutcome; startMs: number; endMs: number; complete: boolean }
interface Baseline { model: MomentumModel | null; probability: number | null; historyIds: string[]; historyAnchors: Record<string, string> }

/** Resumable bounded paper-only runner. Transactions fence concurrent runners; there are no order, key, RPC or model APIs. */
export class SwarmPaperRunner {
  /**
   * Wire persisted paper/calibration storage and the host clock. No RPC, model client, wallet or
   * order service starts.
   */
  constructor(readonly db: ChainDb, readonly clock: () => number = Date.now) {}
  /**
   * Validate a fourteen-day cohort and persist it before its start under an exclusive lock.
   * Identical declarations are idempotent; changed plans or retroactive declaration reject. Host
   * supplies provenance; no ranking is activated.
   */
  async prepareCohort(raw: unknown) {
    const plan = SwarmCalibrationCohortSchema.parse(raw);
    await this.db.tx(async db => {
      await db.sql.query('LOCK TABLE swarm_calibration_cohorts IN EXCLUSIVE MODE');
      const existing = (await db.sql.query<{ data: SwarmCalibrationCohort & { preparedMs: number } }>('SELECT data FROM swarm_calibration_cohorts WHERE id=$1', [plan.id])).rows[0];
      if (existing) {
        const { preparedMs: _, ...prior } = existing.data;
        if (canonicalize(prior) !== canonicalize(plan)) throw new Error('Immutable cohort conflict');
        return;
      }
      const preparedMs = this.clock();
      if (plan.startMs < preparedMs) throw new Error('Cohort must be declared before evaluation');
      await db.sql.query('INSERT INTO swarm_calibration_cohorts VALUES($1,$2)', [plan.id, JSON.stringify({ ...plan, preparedMs })]);
    });
  }
  private async forecasts(db = this.db): Promise<Forecast[]> {
    return (await db.sql.query<Forecast>(`SELECT f.*,p.data AS payload FROM forecasts f JOIN receipt_publications p ON p.id=f.receipt_id ORDER BY f.recorded_at,f.id`)).rows;
  }
  private async canonical(db: ChainDb, block: number, blockHash: string, atMs?: number) {
    const row = (await db.sql.query<{ hash: Uint8Array; ts: Date }>('SELECT hash,ts FROM chain_blocks WHERE number=$1', [block])).rows[0];
    return row && hex(row.hash).toLowerCase() === blockHash.toLowerCase() && (atMs === undefined || new Date(row.ts).getTime() === atMs) ? row : null;
  }
  private async enrolForecast(db: ChainDb, forecast: Forecast) {
    const recordedMs = new Date(forecast.recorded_at).getTime();
    for (const [index, sample] of forecast.payload.deterministicInput.samples.entries()) {
      const vote = PersonaVoteSchema.parse(sample.vote);
      if (vote.action !== 'ape') continue;
      const position = initialPaperPosition(vote, index, recordedMs);
      await db.sql.query('INSERT INTO swarm_paper_positions VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [`${forecast.id}:${index}`, forecast.id, index, forecast.coin, position.dueMs, JSON.stringify(position)]);
    }
  }
  /**
   * Bind immutable feature observations to a canonical forecast cut, enroll paper votes and freeze
   * its weekly baseline from prior canonical outcomes. Reject mismatched availability/provenance
   * or conflicting input; host supplies measured/fixture evidence and no model inference occurs.
   */
  async register(raw: unknown) {
    const input = SwarmCalibrationInputSchema.parse(raw);
    await this.db.tx(async db => {
      await db.sql.query('LOCK TABLE swarm_calibration_inputs IN EXCLUSIVE MODE');
      const forecast = (await this.forecasts(db)).find(f => f.id === input.forecastId);
      if (!forecast) throw new Error('Forecast unavailable');
      const recordedMs = new Date(forecast.recorded_at).getTime();
      if (input.availableMs > recordedMs || input.block !== Number(forecast.as_of_block) || !await this.canonical(db, input.block, input.blockHash)) throw new Error('Feature snapshot cutoff mismatch');
      // Unlabelled heritage forecasts cannot be promoted into measured calibration evidence.
      if (input.evidence === 'measured' && forecast.payload.deterministicInput.evidence !== 'live') throw new Error('Measured forecast provenance unavailable');
      const prior = (await db.sql.query<{ data: SwarmCalibrationInput }>('SELECT data FROM swarm_calibration_inputs WHERE forecast_id=$1', [input.forecastId])).rows[0];
      if (prior && canonicalize(prior.data) !== canonicalize(input)) throw new Error('Immutable feature conflict');
      await db.sql.query('INSERT INTO swarm_calibration_inputs VALUES($1,$2) ON CONFLICT DO NOTHING', [input.forecastId, JSON.stringify(input)]);
      await this.enrolForecast(db, forecast);
      const existing = (await db.sql.query('SELECT forecast_id FROM swarm_calibration_baselines WHERE forecast_id=$1', [input.forecastId])).rows.length;
      if (existing) return;
      const history: MomentumExample[] = [], historyIds: string[] = [], historyAnchors: Record<string, string> = {};
      const weekStart = Math.floor(recordedMs / SWARM_WEEK_MS) * SWARM_WEEK_MS;
      const candidates = (await db.sql.query<{ id: string; input: SwarmCalibrationInput; outcome: Outcome }>(`SELECT i.forecast_id AS id,i.data AS input,o.data AS outcome FROM swarm_calibration_inputs i
        JOIN swarm_calibration_outcomes o ON o.forecast_id=i.forecast_id ORDER BY i.forecast_id,o.anchor_hash`)).rows;
      const seen = new Set<string>();
      for (const row of candidates) {
        if (seen.has(row.id) || !row.outcome.complete || row.input.evidence !== input.evidence || row.input.growth5m === null || row.input.change5mPct === null || row.outcome.endMs > recordedMs || row.outcome.input.availableMs > weekStart) continue;
        const current = await currentReceiptAnchor(db, row.id);
        if (!current || current.blockHash !== row.outcome.input.anchorHash || !await this.canonical(db, Number(current.blockNumber), current.blockHash)) continue;
        seen.add(row.id);
        history.push({ endMs: row.outcome.endMs, growth5m: row.input.growth5m, change5mPct: row.input.change5mPct, outcome: row.outcome.input.netAgentUsd! >= 500 ? 1 : 0 });
        historyIds.push(row.id); historyAnchors[row.id] = current.blockHash;
      }
      const modelId = `${input.evidence}:${weekStart}`;
      const frozen = (await db.sql.query<{ data: { model: MomentumModel | null; historyIds: string[]; historyAnchors: Record<string, string> } }>('SELECT data FROM swarm_momentum_models WHERE id=$1', [modelId])).rows[0]?.data;
      const model = frozen ? frozen.model : fitMomentum(history, recordedMs);
      if (!frozen) await db.sql.query('INSERT INTO swarm_momentum_models VALUES($1,$2)', [modelId, JSON.stringify({ model, historyIds, historyAnchors })]);
      const baseline: Baseline = { model, probability: model && input.growth5m !== null && input.change5mPct !== null ? momentumProbability(model, input.growth5m, input.change5mPct) : null, historyIds: frozen?.historyIds ?? historyIds, historyAnchors: frozen?.historyAnchors ?? historyAnchors };
      await db.sql.query('INSERT INTO swarm_calibration_baselines VALUES($1,$2)', [input.forecastId, JSON.stringify(baseline)]);
    });
  }
  /**
   * Bind a supplied outcome to the current canonical receipt anchor and exact fifteen-minute end
   * block. Return pending/orphaned anchor or observed/censored status; invalid cutoff or immutable
   * conflict rejects. Host supplies coverage and net-agent observations; no oracle is inferred.
   */
  async observe(raw: unknown) {
    const input = SwarmOutcomeSchema.parse(raw);
    return this.db.tx(async db => {
      const anchor = await currentReceiptAnchor(db, input.forecastId);
      if (!anchor || anchor.blockHash !== input.anchorHash) return 'pending_anchor';
      const start = await this.canonical(db, Number(anchor.blockNumber), anchor.blockHash);
      if (!start) return 'orphaned_anchor';
      const end = await this.canonical(db, input.endBlock, input.endBlockHash);
      const startMs = new Date(start.ts).getTime(), endMs = startMs + 900000;
      const forecast = (await this.forecasts(db)).find(f => f.id === input.forecastId);
      if (!forecast || startMs < new Date(forecast.recorded_at).getTime()) throw new Error('Commit precedes forecast');
      // Exact end cut; a later block must never include buys after the fifteen-minute window.
      if (!end || new Date(end.ts).getTime() !== endMs || input.availableMs < endMs) throw new Error('Outcome window cutoff mismatch');
      const outcome: Outcome = { input, startMs, endMs, complete: Object.values(input.coverage).every(Boolean) && input.netAgentUsd !== null };
      const prior = (await db.sql.query<{ data: Outcome }>('SELECT data FROM swarm_calibration_outcomes WHERE forecast_id=$1 AND anchor_hash=$2', [input.forecastId, input.anchorHash])).rows[0];
      if (prior && canonicalize(prior.data) !== canonicalize(outcome)) throw new Error('Immutable outcome conflict');
      await db.sql.query('INSERT INTO swarm_calibration_outcomes VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [input.forecastId, input.anchorHash, JSON.stringify(outcome)]);
      return outcome.complete ? 'observed' : 'censored';
    });
  }
  /**
   * Advance paper positions once for a canonical increasing snapshot cutoff under a checkpoint
   * lock, using retained price/simulation evidence. Equal immutable ticks return replayed;
   * conflicting/reversed cuts reject. Persist paper events and grades atomically; failed exits
   * remain open and no live orders occur.
   */
  async tick(raw: unknown) {
    const tick = SwarmPaperTickSchema.parse(raw);
    if (new Set(tick.prices.map(p => p.coin.toLowerCase())).size !== tick.prices.length || new Set(tick.simulations.map(s => s.positionId)).size !== tick.simulations.length) throw new Error('Duplicate tick sources');
    return this.db.tx(async db => {
      await db.sql.query('LOCK TABLE swarm_paper_checkpoint IN EXCLUSIVE MODE');
      if (!await this.canonical(db, tick.block, tick.blockHash, tick.atMs)) throw new Error('Paper snapshot pin mismatch');
      const replay = (await db.sql.query<{ data: SwarmPaperTick }>('SELECT data FROM swarm_paper_ticks WHERE id=$1', [tick.id])).rows[0];
      if (replay) {
        if (canonicalize(replay.data) !== canonicalize(tick)) throw new Error('Immutable tick conflict');
        return { code: 'replayed', positions: 0 };
      }
      const prior = (await db.sql.query<{ through_ms: string; tick_id: string }>("SELECT * FROM swarm_paper_checkpoint WHERE id='swarm-paper-1'")).rows[0];
      if (prior && tick.cutoffMs <= Number(prior.through_ms)) {
        throw new Error('Paper checkpoint cutoff must advance');
      }
      for (const forecast of await this.forecasts(db)) if (new Date(forecast.recorded_at).getTime() <= tick.cutoffMs) await this.enrolForecast(db, forecast);
      await db.sql.query('INSERT INTO swarm_paper_ticks VALUES($1,$2)', [tick.id, JSON.stringify(tick)]);
      const positions = (await db.sql.query<{ id: string; coin: string; data: PaperPosition }>('SELECT id,coin,data FROM swarm_paper_positions ORDER BY id FOR UPDATE')).rows;
      let processed = 0;
      for (const row of positions) {
        const p = row.data;
        if (p.status === 'closed' || p.status === 'entry_failed') continue;
        const price = tick.prices.find(p => p.coin.toLowerCase() === row.coin.toLowerCase());
        const side = p.status === 'pending' ? 'buy' : 'sell';
        const wanted = side === 'buy' ? tick.cutoffMs >= p.dueMs : paperExitReason(p, tick.cutoffMs, price?.markUsd ?? null) !== null;
        const supplied = tick.simulations.find(s => s.positionId === row.id);
        let leg = null;
        if (wanted && supplied && price) {
          const result = (await db.sql.query<{ data: ReferenceResult | PonsResult; acquired_at: Date }>('SELECT data,acquired_at FROM sim_runs WHERE id=$1', [supplied.referenceId])).rows[0];
          if (result && new Date(result.acquired_at).getTime() <= tick.cutoffMs && result.data.coin.toLowerCase() === row.coin.toLowerCase() && result.data.cursor.blockNumber === String(tick.block) && result.data.cursor.blockHash === tick.blockHash &&
            result.data.sizeUsd === p.sizeUsd && (side === 'sell' || tick.atMs >= p.dueMs)) {
            let held = side === 'buy';
            if (side === 'sell' && supplied.heldEntryReference === p.entryReference && result.data.methodVersion === 'pons-reference-1') {
              const entry = (await db.sql.query<{ data: PonsResult }>('SELECT data FROM sim_runs WHERE id=$1', [p.entryReference])).rows[0]?.data;
              held = !!entry && entry.methodVersion === 'pons-reference-1' && entry.routeId === result.data.routeId &&
                result.data.observations.filter(o => o.mode === 'sell_only' && o.accountClass === 'eoa').every(o => entry.observations.some(e => e.mode === 'round_trip' && e.account === o.account && e.tokens === p.tokens));
            }
            leg = held ? referencePaperLeg(result.data, { side, position: p, ethUsd: price.ethUsd, decimals: price.decimals, referenceId: supplied.referenceId }) :
              { status: 'state_unavailable' as const, referenceId: supplied.referenceId, tokens: '0', quoteUsd: 0, networkUsd: 0, decimals: price.decimals, buyTaxPct: null, sellTaxPct: null };
          }
        }
        const step = stepPaper(p, tick.cutoffMs, price?.markUsd ?? null, leg);
        const event = { atMs: tick.cutoffMs, block: tick.block, blockHash: tick.blockHash, code: step.code, leg, position: step.position };
        await db.sql.query('INSERT INTO swarm_paper_events VALUES($1,$2,$3)', [row.id, tick.id, JSON.stringify(event)]);
        await db.sql.query('UPDATE swarm_paper_positions SET data=$2 WHERE id=$1', [row.id, JSON.stringify(step.position)]);
        if (step.grade) await db.sql.query('INSERT INTO swarm_paper_grades VALUES($1,$2)', [row.id, JSON.stringify({ ...step.grade, tickId: tick.id, entryReference: step.position.entryReference, exitReference: leg?.referenceId ?? null, evidence: 'paper' })]);
        processed++;
      }
      await db.sql.query("INSERT INTO swarm_paper_checkpoint VALUES('swarm-paper-1',$1,$2) ON CONFLICT(id) DO UPDATE SET through_ms=excluded.through_ms,tick_id=excluded.tick_id", [tick.cutoffMs, tick.id]);
      return { code: 'advanced', positions: processed };
    });
  }
  /**
   * Recheck forecast, input, baseline and outcome anchors, calculate calibration and persist a
   * content-addressed report for an optional predeclared cohort. Missing/cohort/provenance
   * evidence adds acceptance reasons; invalid cohort/storage failures reject. No live ranking
   * switch, model call or real trade occurs.
   */
  async report(nowMs: number, cohortId?: string) {
    return this.db.tx(async db => {
      const plan = cohortId ? (await db.sql.query<{ data: SwarmCalibrationCohort }>('SELECT data FROM swarm_calibration_cohorts WHERE id=$1', [cohortId])).rows[0]?.data : null;
      if (cohortId && !plan) throw new Error('Cohort unavailable');
      const rows: CalibrationRow[] = [];
      for (const forecast of await this.forecasts(db)) {
        const recordedMs = new Date(forecast.recorded_at).getTime();
        if (recordedMs <= nowMs) await this.enrolForecast(db, forecast);
        if (plan && (recordedMs < plan.startMs || recordedMs >= plan.endMs)) continue;
        const anchor = await currentReceiptAnchor(db, forecast.id);
        const header = anchor ? await this.canonical(db, Number(anchor.blockNumber), anchor.blockHash) : null;
        const input = (await db.sql.query<{ data: SwarmCalibrationInput }>('SELECT data FROM swarm_calibration_inputs WHERE forecast_id=$1', [forecast.id])).rows[0]?.data;
        const baseline = (await db.sql.query<{ data: Baseline }>('SELECT data FROM swarm_calibration_baselines WHERE forecast_id=$1', [forecast.id])).rows[0]?.data;
        const outcome = anchor ? (await db.sql.query<{ data: Outcome }>('SELECT data FROM swarm_calibration_outcomes WHERE forecast_id=$1 AND anchor_hash=$2', [forecast.id, anchor.blockHash])).rows[0]?.data : null;
        let baselineValid = !!baseline;
        for (const [id, blockHash] of Object.entries(baseline?.historyAnchors ?? {})) {
          const dependency = await currentReceiptAnchor(db, id);
          if (!dependency || dependency.blockHash !== blockHash || !await this.canonical(db, Number(dependency.blockNumber), blockHash)) baselineValid = false;
        }
        const inputValid = !!input && !!await this.canonical(db, input.block, input.blockHash);
        const outcomeValid = !!outcome && !!await this.canonical(db, outcome.input.endBlock, outcome.input.endBlockHash);
        const startMs = header ? new Date(header.ts).getTime() : new Date(forecast.recorded_at).getTime();
        rows.push({ id: forecast.id, coin: forecast.coin, evidence: input?.evidence ?? 'fixture', startMs, endMs: startMs + 900000,
          committed: !!header && startMs >= new Date(forecast.recorded_at).getTime(), complete: inputValid && outcomeValid && !!outcome?.complete && outcome.input.availableMs <= nowMs && !!input && input.availableMs <= new Date(forecast.recorded_at).getTime(), probability: forecast.data.apeShare,
          baseline: baselineValid ? baseline?.probability ?? null : null, netAgentUsd: outcome?.input.netAgentUsd ?? null });
      }
      const calibration = calibrationReport(rows, { nowMs });
      if (!plan) calibration.reasons.push('cohort_not_predeclared');
      if (plan && nowMs < plan.endMs + 900000) calibration.reasons.push('cohort_in_progress');
      if (plan && rows.some(r => r.evidence !== plan.evidence)) calibration.reasons.push('cohort_provenance_mismatch');
      calibration.acceptanceCandidate = calibration.reasons.length === 0;
      const report = { ...calibration, cohortPlan: plan ?? null, generatedMs: nowMs, forecastIds: rows.map(r => r.id),
        paper: (await db.sql.query("SELECT data->>'status' AS status,count(*)::int AS count FROM swarm_paper_positions GROUP BY data->>'status' ORDER BY status")).rows,
        checkpoint: (await db.sql.query('SELECT * FROM swarm_paper_checkpoint')).rows, runnerModelCostUsd: 0, forecastInferenceCostUsd: null };
      const id = digest(report);
      await db.sql.query('INSERT INTO swarm_calibration_reports VALUES($1,$2) ON CONFLICT DO NOTHING', [id, JSON.stringify(report)]);
      return { id, ...report };
    });
  }
}
