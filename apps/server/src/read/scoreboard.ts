import { z } from 'zod';
import { createHash } from 'node:crypto';
import { hex, type ChainDb } from '@eko/db';
import { readOutcomeLabels, type OutcomeLabelRevision } from '@eko/engines';
import { AddressSchema, AvailabilityCutSchema, Bytes32Schema, PublicReceiptPayloadSchema, ScoreboardResponseSchema,
  ScoreboardRowSchema, TradeQuoteSchema, VerdictSchema, guardKnownBy, canonicalize,
  type Address, type AvailabilityCut, type ScoreboardKind, type ScoreboardRow } from '@eko/shared';
import { PostFillEvidenceSchema } from '../exec/trade-evidence.js';
import { decodeCursor, encodeCursor } from './pagination.js';
import { InputError } from '../http/v1/helpers.js';
import { reportError } from '../obs/errors.js';

const ids = z.array(Bytes32Schema).min(1).max(100);
/** Publications consumed per pass; keeps one pass well under the api heap even on a freshly restored database. */
export const CONSUME_BATCH = 2000;
/**
 * How far below the consumed mark a pass still looks for publications without a row. A publication's sequence number
 * is taken when it is written, not when it commits, so one can appear below the mark after a later one was consumed.
 */
export const PUBLICATION_OVERLAP = 5000n;
const coverageSchema = z.strictObject({ id: Bytes32Schema, origin: z.literal('measured'), evidenceIds: ids,
  from: z.iso.datetime(), through: z.iso.datetime(), refused: z.boolean(), missed: z.boolean() })
  .refine(p => Date.parse(p.through) >= Date.parse(p.from) && (p.refused || p.missed));
type Coverage = z.infer<typeof coverageSchema>;
type RecordRow<T> = { seq: string; source_key: string; data: T };
type Accepted = { revisionId: string; streamId: string; cut: AvailabilityCut; evidenceIds: string[]; label: OutcomeLabelRevision };
const key = (data: unknown) => createHash('sha256').update(canonicalize(data)).digest('hex');
const ts = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();
const unavailable = (reason: 'monitoring_missing' | 'coverage_gap' | 'outcomes_unaccepted' | 'forecast_dependency' | 'd0_gated' | 'milestones_unaccepted') => ({ status: 'unavailable' as const, reason });

/** CA-15. Trusted host methods are deliberately separate from the public read route.
 * No source payload, wallet, calldata, journal or acquisition token is projected. */
export class ScoreboardService {
  /**
   * Wire durable Scoreboard records, clock and launch-phase reader. Host construction performs no
   * outcome acceptance, acquisition or authentication.
   */
  constructor(readonly db: ChainDb, readonly now: () => number = Date.now, readonly phase: () => string = () => 'launch_week') {}
  private async append(db: ChainDb, source: string, category: 'row' | 'coverage' | 'outcome', data: unknown) {
    await db.sql.query('INSERT INTO scoreboard_records(source_key,category,data) VALUES($1,$2,$3) ON CONFLICT(source_key) DO NOTHING', [source, category, JSON.stringify(data)]);
    const prior = (await db.sql.query<{ category: string; data: unknown }>('SELECT category,data FROM scoreboard_records WHERE source_key=$1', [source])).rows[0]!;
    if (prior.category !== category || canonicalize(prior.data) !== canonicalize(data)) throw new Error('Scoreboard source identity conflict');
  }
  private row(db: ChainDb, source: string, row: Omit<ScoreboardRow, 'id'>) {
    return this.append(db, source, 'row', ScoreboardRowSchema.parse({ ...row, id: source }));
  }
  /** Many fresh rows in one statement. Only for sources known to have no row yet (the caller filtered with NOT EXISTS);
   * a race with another writer is harmless because the key conflict is ignored and the row is identical by construction. */
  private async rows(db: ChainDb, rows: { source: string; row: Omit<ScoreboardRow, 'id'> }[]) {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map(r => ({ source: r.source, data: JSON.stringify(ScoreboardRowSchema.parse({ ...r.row, id: r.source })) }));
      await db.sql.query(`INSERT INTO scoreboard_records(source_key,category,data) SELECT k,'row',d::jsonb FROM unnest($1::text[],$2::text[]) AS t(k,d) ON CONFLICT(source_key) DO NOTHING`,
        [chunk.map(c => c.source), chunk.map(c => c.data)]);
    }
  }
  private timer?: ReturnType<typeof setInterval>;
  /** Production: consume new evidence every `ms` in the background, so a page request never pays for a large batch
   * (the first request after the scanner rated thousands of coins took 51 s on 2026-10-10). Tests and tools, which
   * never call start(), still consume inline in list(). */
  start(ms = 15_000) { this.timer = setInterval(() => { void this.sync().catch(error => reportError(error, { where: 'scoreboard consume' })); }, ms); this.timer.unref(); }
  /** Stop the background consumer; an in-flight consume finishes on its own transaction. */
  async close() { clearInterval(this.timer); this.timer = undefined; }
  /** True while the background consumer runs, so list() serves what has been consumed instead of consuming inline. */
  get background() { return this.timer !== undefined; }
  /**
   * The publication sequence through which this process has consumed every verdict publication, and the value a pass
   * in progress will move it to once its transaction commits. A new process has none and reads every publication once.
   */
  private consumedThrough?: bigint;
  private stagedThrough?: bigint;
  /** Run a transaction that may consume; the mark moves only when it commits. */
  private async marked<T>(run: () => Promise<T>): Promise<T> {
    this.stagedThrough = undefined;
    const result = await run();
    if (this.stagedThrough != null) this.consumedThrough = this.stagedThrough;
    this.stagedThrough = undefined;
    return result;
  }
  /** One consume pass under the Scoreboard lock: the timer's body, also callable by tests and tools. */
  async sync() { await this.marked(() => this.db.tx(async db => { await db.sql.query("SELECT pg_advisory_xact_lock(hashtext('scoreboard'))"); await this.consume(db); })); }
  /** A reviewed monitoring interval, never inferred from process boot or the first incident.
   * TODO(spec): CA-15 does not name coverage acquisition. The host supplies accepted
   * measured intervals; gaps and a stale end remain unavailable, even with existing rows. */
  async recordCoverage(raw: unknown) {
    const period = coverageSchema.parse(raw);
    if (Date.parse(period.through) > this.now()) throw new Error('Monitoring interval is in the future');
    await this.db.tx(async db=>{await db.sql.query("SELECT pg_advisory_xact_lock(hashtext('scoreboard'))");await this.append(db, `coverage:${period.id}`, 'coverage', period);});
  }
  /** Accept a reviewed refusal from the retained trade, not a failed scan or provider error.
   * TODO(spec): the current trade quote has no measured-refusal envelope. Until a host
   * supplies this independent token restriction proof, a refuse check alone is not counted. */
  async recordRefusal(quoteId: string, raw: unknown) {
    const proof = z.strictObject({ id: Bytes32Schema, coin: AddressSchema, account: AddressSchema, cut: AvailabilityCutSchema,
      origin: z.literal('measured'), failure: z.literal('token_enforced'), independentlyReproduced: z.literal(true),
      temporaryResolved: z.literal(true), evidenceIds: ids }).parse(raw);
    await this.db.tx(async db => {
      await db.sql.query("SELECT pg_advisory_xact_lock(hashtext('scoreboard'))");
      const r = (await db.sql.query<{ quote: unknown; wallet: string; checked: { order?: { execution?: { guardReceiptId?: string } } } | null }>('SELECT quote,wallet,checked FROM trade_quotes WHERE id=$1', [z.uuid().parse(quoteId)])).rows[0];
      if (!r) throw new Error('Refusal quote missing');
      const q = TradeQuoteSchema.parse(r.quote);
      if (q.side !== 'buy' || q.coin !== proof.coin || q.account !== proof.account || r.wallet !== proof.account || q.guard.decision !== 'refuse'
        || !q.guard.checks.some(c => c.status === 'refuse' && c.code === 'honeypot') || !r.checked?.order?.execution?.guardReceiptId
        || q.asOfBlock !== Number(proof.cut.cursor.blockNumber) || await db.blockHash(BigInt(proof.cut.cursor.blockNumber)) !== proof.cut.cursor.blockHash)
        throw new Error('Refusal proof does not bind the retained token restriction');
      await this.row(db, `refusal:${quoteId}`, { kind: 'honeypots_refused', ts: ts(proof.cut.cursor.timestampSec), coin: q.coin,
        receiptId: r.checked.order.execution.guardReceiptId, detail: { origin: 'measured', evidenceId: proof.id, code: 'token_enforced', blockNumber:proof.cut.cursor.blockNumber, blockHash:proof.cut.cursor.blockHash } });
    });
  }
  /** 051 owns the oracle. Approval only binds an existing canonical measured revision;
   * it never promotes fixture data or reconstructs an outcome from legacy labels. */
  async acceptOutcome(streamId: string, rawCut: unknown, evidenceIds: unknown) {
    const cut = AvailabilityCutSchema.parse(rawCut), evidence = ids.parse(evidenceIds);
    return this.db.tx(async db => {
      await db.sql.query("SELECT pg_advisory_xact_lock(hashtext('scoreboard'))");
      const label = await readOutcomeLabels(db, streamId, cut);
      if (!label || label.origin !== 'measured' || !label.maturityCursor
        || BigInt(label.knownAt.cursor.timestampSec) < BigInt(label.maturityCursor.timestampSec) + 30n
        || label.records.some(r => r.status === 'provisional')) throw new Error('Outcome is not a mature measured revision');
      const record: Accepted = { revisionId: label.id, streamId, cut, evidenceIds: evidence, label };
      await this.append(db, `accepted:${label.id}`, 'outcome', record);
      return label.id;
    });
  }
  private async outcomes(db: ChainDb) {
    const accepted = (await db.sql.query<RecordRow<Accepted>>("SELECT seq,source_key,data FROM scoreboard_records WHERE category='outcome' ORDER BY seq")).rows;
    const result: Accepted[] = [];
    for (const a of accepted) {
      // Recheck the current canonical source and all immutable invalidation events.
      const current = await readOutcomeLabels(db, a.data.streamId, a.data.cut);
      const invalid = (await db.sql.query('SELECT 1 FROM outcome_label_events WHERE target_id IN (SELECT id FROM outcome_label_revisions WHERE data->>\'id\'=$1) AND kind<>\'superseded\'', [a.data.revisionId])).rows.length;
      if (current?.id === a.data.revisionId && !invalid) result.push(a.data);
    }
    return result;
  }
  private classify(label: OutcomeLabelRevision) {
    const qualified = label.records.filter(r => r.status === 'confirmed_under_policy' && r.qualification === 'qualified');
    const adverse = qualified.some(r => r.kind !== 'survived');
    const survived = label.complete && qualified.some(r => r.kind === 'survived');
    return { adverse, survived, assessable: adverse || survived, rug: qualified.some(r => r.kind === 'rug') };
  }
  private async consume(db: ChainDb) {
    const misses = (await db.sql.query<{ order_id: string; created_at: Date; payload: Record<string, unknown>; coin: string; tx_hash: string; filled_out: string; wallet: string; post_fill_evidence: unknown }>(`SELECT m.order_id,m.created_at,m.payload,o.coin,o.tx_hash,o.filled_out,o.post_fill_evidence,q.wallet
      FROM trade_guard_misses m JOIN trade_orders o ON o.id=m.order_id JOIN trade_quotes q ON q.id=o.quote_id
      WHERE o.status='confirmed' AND o.side='buy' AND NOT EXISTS (SELECT 1 FROM scoreboard_records s WHERE s.source_key='miss:'||m.order_id::text)
      ORDER BY m.created_at,m.order_id`)).rows;
    for (const m of misses) {
      const parsed = PostFillEvidenceSchema.safeParse(m.post_fill_evidence);
      if (!parsed.success) continue;
      const e = parsed.data;
      if (e.status !== 'failed' || e.origin !== 'measured' || e.txHash !== m.tx_hash || e.account !== m.wallet || e.amount !== m.filled_out
        || await db.blockHash(BigInt(e.blockNumber)) !== e.blockHash) continue;
      await this.row(db, `miss:${m.order_id}`, { kind: 'honeypots_missed', ts: new Date(m.created_at).toISOString(), coin: AddressSchema.parse(m.coin),
        txHash: e.txHash, ...(typeof m.payload.guardReceiptId === 'string' ? { receiptId: m.payload.guardReceiptId } : {}),
        detail: { origin: 'measured', postMortemStatus: 'pending', evidenceCount: e.evidenceIds.length, blockNumber:e.blockNumber, blockHash:e.blockHash } });
    }
    const measuredRows=(await db.sql.query<{data:ScoreboardRow}>("SELECT data FROM scoreboard_records WHERE category='row' AND data->>'kind' IN ('honeypots_refused','honeypots_missed') AND data->'detail'->>'blockNumber' IS NOT NULL")).rows;
    for(const {data:r} of measuredRows)if(!r.detail.correctionOf && await db.blockHash(BigInt(r.detail.blockNumber!))!==r.detail.blockHash)
      await this.row(db,`counter-reorg:${r.id}`,{...r,detail:{...r.detail,event:'correction',correctionOf:r.id,counterEffect:'retracted',reason:'source_orphaned'}});
    // Rows are append-only and keyed by source, so only publications without a row are read. Reading every
    // publication on every request made the public scoreboard time out once the engines had rated thousands of coins.
    // Bounded per pass: a restored database can carry tens of thousands of unconsumed publications (14,695 on the
    // 2026-10-10 cutover rehearsal), and loading every payload at once exhausted the api's heap. The timer's next
    // passes take the rest within minutes.
    // Once a pass has found fewer than a batch, later passes look only above the sequence it had reached (less the
    // overlap): checking every publication for a row every 15 s was 166,981 index probes and 4.75 s on a copy of
    // 2026-10-13 to return nothing, and 0.44 of a backend in production; 0.19 s this way.
    const head = BigInt((await db.sql.query<{ seq: string | null }>('SELECT max(publication_sequence)::text AS seq FROM receipt_publications')).rows[0]?.seq ?? '0');
    const above = this.consumedThrough == null ? null : this.consumedThrough - PUBLICATION_OVERLAP;
    const calls = (await db.sql.query<{ id: string; data: unknown;summary:{coin:Address;recordedAt:string;level:ScoreboardRow['level'];rulesVersion:string;revisionId:string;receiptId:string;window:{kind:string;blockNumber:number}}|null }>(`SELECT p.id,p.data,p.summary FROM receipt_publications p WHERE p.kind='verdict' AND p.chain_id=4663
      ${above == null ? '' : 'AND p.publication_sequence>$1'}
      AND NOT EXISTS (SELECT 1 FROM scoreboard_records s WHERE s.source_key='call:'||p.id) ORDER BY p.publication_sequence LIMIT ${CONSUME_BATCH}`, above == null ? [] : [above.toString()])).rows;
    if (calls.length < CONSUME_BATCH) this.stagedThrough = head;
    const callRows: { source: string; row: Omit<ScoreboardRow, 'id'> }[] = [];
    for (const c of calls) {
      const p = PublicReceiptPayloadSchema.safeParse(c.data);
      if(!p.success && c.summary) {
        const a=c.summary;
        callRows.push({source:`call:${c.id}`,row:{kind:'calls',ts:a.recordedAt,coin:a.coin,level:a.level,receiptId:a.receiptId,
          detail:{event:'call',gradeStatus:'unavailable',rulesVersion:a.rulesVersion,revisionId:a.revisionId,decisionBlock:a.window.kind==='snapshot' ? a.window.blockNumber : 'unavailable'}}});
        continue;
      }
      if (!p.success || p.data.kind !== 'verdict') continue; // Candidate V2/shadow is not an active V1 call.
      const verdict = VerdictSchema.omit({receipt:true}).safeParse(p.data.decision);
      if (!verdict.success) continue;
      callRows.push({ source: `call:${c.id}`, row: { kind: 'calls', ts: p.data.recordedAt, coin: p.data.coin, level: verdict.data.level,
        receiptId: p.data.receiptId, detail: { ...verdict.data.priceMove, event: 'call', gradeStatus: 'unavailable', rulesVersion: p.data.rulesVersion, revisionId: p.data.revisionId, decisionBlock: p.data.window.kind === 'snapshot' ? p.data.window.blockNumber : 'unavailable' } } });
    }
    await this.rows(db, callRows);
    const corrections = (await db.sql.query<{ id: string; kind: string; verdict_id: string; coin: Uint8Array; data: unknown; ts: Date }>(`SELECT e.id,e.kind,e.verdict_id,v.coin,v.data,b.ts
      FROM verdict_events e JOIN verdicts v ON v.id=e.verdict_id JOIN chain_blocks b ON b.number=e.block
      WHERE e.kind IN ('corrected','orphaned') AND NOT EXISTS (SELECT 1 FROM scoreboard_records s WHERE s.source_key='correction:'||e.id) ORDER BY e.block,e.id`)).rows;
    for (const c of corrections) {
      const v = VerdictSchema.safeParse(c.data); if (!v.success) continue;
      await this.row(db, `correction:${c.id}`, { kind: 'calls', ts: new Date(c.ts).toISOString(), coin: hex(c.coin), level: v.data.level,
        receiptId: v.data.receipt.id, grade: 'n/a', detail: { event: c.kind, correctionOf: c.verdict_id, gradeStatus: 'withdrawn' } });
    }
    const outcomes = await this.outcomes(db);
    // TODO(spec): receipt hit/miss semantics are unspecified. Use the 24h horizon,
    // Danger vs confirmed adverse / Clear vs complete survival; Monitor/pending are n/a.
    const withdrawnIds = new Set((await db.sql.query<{ verdict_id: string }>("SELECT verdict_id FROM verdict_events WHERE kind IN ('corrected','orphaned')")).rows.map(r => r.verdict_id));
    const outcomeCoins = [...new Set(outcomes.map(a => a.label.records[0]?.coin).filter((c): c is Address => !!c))];
    const rows = outcomeCoins.length ? (await db.sql.query<RecordRow<ScoreboardRow>>(`SELECT seq,source_key,data FROM scoreboard_records WHERE category='row' AND data->>'kind'='calls'
      AND data->'detail'->>'event'='call' AND data->>'coin'=ANY($1) ORDER BY seq`, [outcomeCoins])).rows : [];
    for (const { data: call } of rows) {
      const eligible = outcomes.filter(a => a.label.records[0]?.coin === call.coin && a.label.records[0]?.horizonSec === 86400
        && Date.parse(call.ts) <= Number(a.label.records[0]?.entryCursor?.timestampSec ?? '0') * 1000 && Number(call.detail.decisionBlock) <= Number(a.label.records[0]?.entryCursor?.blockNumber ?? '0'));
      const a = eligible.at(-1); if (!a) continue;
      const state = this.classify(a.label);
      const withdrawn = withdrawnIds.has(String(call.detail.revisionId));
      const grade = withdrawn || !state.assessable || !['clear', 'danger'].includes(call.level ?? '') ? 'n/a'
        : call.level === 'clear' ? state.survived ? 'hit' : 'miss' : state.adverse ? 'hit' : 'miss';
      await this.row(db, `grade:${call.id}:${a.revisionId}:${withdrawn}`, { ...call, grade, ts: ts(a.label.knownAt.cursor.timestampSec),
        detail: { ...call.detail, event: 'grade', gradeStatus: withdrawn ? 'withdrawn' : state.assessable ? 'observed' : 'censored',
          callId: call.id, outcomeRevision: a.revisionId, outcomeVersion: a.label.records[0]!.outcomeVersion, horizonSec: 86400 } });
    }
    const cohorts=(await db.sql.query<{data:ScoreboardRow}>("SELECT data FROM scoreboard_records WHERE category='row' AND data->>'kind'='cohort' AND data->'detail'->>'outcomeRevisions' IS NOT NULL")).rows;
    const validOutcomeIds=new Set(outcomes.map(o=>o.revisionId));
    for(const {data:c} of cohorts)if(!c.detail.correctionOf && (JSON.parse(String(c.detail.outcomeRevisions)) as string[]).some(id=>!validOutcomeIds.has(id))) {
      const detail:ScoreboardRow['detail']={...c.detail,event:'correction',correctionOf:c.id,medianStatus:'unavailable',rugRateStatus:'unavailable',reason:'source_invalidated'};
      delete detail.medianOutcomePct;delete detail.rugRatePct;
      await this.row(db,`cohort-invalidated:${c.id}`,{...c,detail});
    }
    // A source withdrawal appends a new grade; prior receipt and grade rows remain intact.
    const grades = (await db.sql.query<RecordRow<ScoreboardRow>>("SELECT seq,source_key,data FROM scoreboard_records WHERE category='row' AND data->'detail'->>'event'='grade' ORDER BY seq")).rows;
    const valid = new Set(outcomes.map(o => o.revisionId));
    for (const { data: g } of grades) if (!valid.has(String(g.detail.outcomeRevision)))
      await this.row(db, `grade-invalidated:${g.id}`, { ...g, grade: 'n/a', detail: { ...g.detail, event: 'correction', correctionOf: g.id, gradeStatus: 'source_invalidated' } });
  }
  /** Reviewed UTC weekly universe and point-in-time publication cut. All indexed
   * eligible launches participate, including ungraded, immature and censored members.
   * TODO(spec): the comparison cut is t0+60s, 24h net benchmark outcome; UTC Monday
   * weeks. The host attests launch-universe coverage, not the presence of outcomes. */
  async publishCohort(raw: unknown) {
    const input = z.strictObject({ week: z.iso.datetime(), cut: AvailabilityCutSchema, origin: z.literal('measured'),
      launchCoverageComplete: z.literal(true), evidenceIds: ids, outcomeVersion: z.string().min(1), identityVersion: z.string().min(1) }).parse(raw);
    const start = Date.parse(input.week), end = start + 7 * 86400000;
    if (new Date(start).getUTCDay() !== 1 || start % 86400000 !== 0 || end > Number(input.cut.cursor.timestampSec) * 1000)
      throw new Error('Cohort requires a closed UTC Monday week');
    return this.marked(() => this.db.tx(async db => {
      if (await db.blockHash(BigInt(input.cut.cursor.blockNumber)) !== input.cut.cursor.blockHash) throw new Error('Cohort cut is not canonical');
      await db.sql.query("SELECT pg_advisory_xact_lock(hashtext('scoreboard'))");
      await this.consume(db);
      if((await db.sql.query('SELECT 1 FROM scoreboard_records WHERE source_key=$1',[`cohort:${key(input)}:all`])).rows.length)return;
      const launches = (await db.sql.query<{ coin: Uint8Array; ts: Date; first_block: string }>(`SELECT t.address AS coin,b.ts,t.first_block FROM tokens t JOIN chain_blocks b ON b.number=t.first_block
        WHERE b.ts>=$1 AND b.ts<$2 AND t.first_block<=$3 ORDER BY t.first_block,t.address`, [new Date(start), new Date(end), input.cut.cursor.blockNumber])).rows;
      const accepted = (await this.outcomes(db)).filter(a => guardKnownBy(a.label.knownAt, input.cut) && a.label.records[0]?.horizonSec === 86400
        && a.label.records[0]?.outcomeVersion === input.outcomeVersion && a.label.records[0]?.identityVersion === input.identityVersion);
      const members: { coin: Address; clear: boolean; immature: boolean; outcome: Accepted | undefined }[] = [];
      for (const l of launches) {
        const coin = hex(l.coin);
        // The original publication must have been available by launch+60s. A
        // backdated chain state, later correction or later Clear cannot join it.
        const publications = (await db.sql.query<{ data: unknown;summary:{level:string;window:{kind:string;blockNumber:number}}|null }>(`SELECT data,summary FROM receipt_publications WHERE kind='verdict' AND coalesce(data->>'coin',summary->>'coin')=$1
          AND recorded_at<=$2 AND recorded_at<=to_timestamp($3) ORDER BY recorded_at,publication_sequence`, [coin, new Date(new Date(l.ts).getTime() + 60000), input.cut.cursor.timestampSec])).rows;
        let clear = false;
        for (const r of publications) {
          if(r.data==null && r.summary?.window.kind==='snapshot' && r.summary.window.blockNumber<=Number(input.cut.cursor.blockNumber)) {clear=r.summary.level==='clear';break;}
          const p = PublicReceiptPayloadSchema.safeParse(r.data);
          if (!p.success || p.data.window.kind !== 'snapshot' || p.data.window.blockNumber > Number(input.cut.cursor.blockNumber)) continue;
          const v = VerdictSchema.omit({receipt:true}).safeParse(p.data.decision); if (v.success) { clear = v.data.level === 'clear'; break; }
        }
        members.push({ coin, clear, immature: new Date(l.ts).getTime()+86430000 > Number(input.cut.cursor.timestampSec)*1000, outcome: accepted.filter(a => a.label.records[0]?.coin === coin).at(-1) });
      }
      for (const group of ['all', 'clear'] as const) {
        const set = members.filter(m => group === 'all' || m.clear);
        let evaluated = 0, rugs = 0, censored = 0, rugDenominator = 0;
        const immature = set.filter(m=>m.immature).length;
        const returns: number[] = [];
        for (const m of set) {
          if (!m.outcome || m.immature) continue;
          const s = this.classify(m.outcome.label);
          const rugKnown = m.outcome.label.records.filter(r=>r.kind==='rug').every(r=>r.status==='confirmed_under_policy' && r.qualification!=='unknown');
          if(rugKnown) { rugDenominator++; if(s.rug) rugs++; }
          if (!s.assessable) { censored++; continue; }
          evaluated++;
          // 051 retains independently executed benchmark amounts in the survival
          // record. Partial/adverse labels do not fabricate a terminal return.
          const survived = m.outcome.label.records.find(r => r.kind === 'survived');
          const details = survived?.details as { benchmarks?: { sizeUsd: number; complete: boolean; entry: { inputQuote: { numerator: string; denominator: string }; gasQuote: { numerator: string; denominator: string } } | null; checkpoints: { netQuote?: { numerator: string; denominator: string } | null }[] }[] } | undefined;
          const b = details?.benchmarks?.find(b => b.sizeUsd === 100 && b.complete), exit = b?.checkpoints.at(-1)?.netQuote;
          const ratio = (r: { numerator: string; denominator: string }) => Number(r.numerator) / Number(r.denominator);
          if (b?.entry && exit) {
            const cost = ratio(b.entry.inputQuote) + ratio(b.entry.gasQuote), value = ratio(exit), ret = (value - cost) * 100 / cost;
            if (cost > 0 && Number.isFinite(ret)) returns.push(ret);
          }
        }
        returns.sort((a, b) => a - b);
        const median = returns.length ? (returns[Math.floor((returns.length - 1) / 2)]! + returns[Math.floor(returns.length / 2)]!) / 2 : null;
        const membershipHash = key(set.map(m => m.coin));
        await this.row(db, `cohort:${key(input)}:${group}`, { kind: 'cohort', ts: ts(input.cut.cursor.timestampSec), detail: {
          week: input.week, group, eligible: set.length, evaluated, censored, immature, ungraded: set.length - evaluated - censored - immature, rugs,
          rugDenominator, rugRateStatus: rugDenominator ? 'observed' : 'unavailable', ...(rugDenominator ? { rugRatePct: rugs / rugDenominator * 100 } : {}),
          medianStatus: median === null ? 'unavailable' : 'observed', medianDenominator: returns.length, ...(median === null ? {} : { medianOutcomePct: median }),
          membershipHash, outcomeRevisions:JSON.stringify(set.flatMap(m=>m.outcome?[m.outcome.revisionId]:[])), outcomeVersion: input.outcomeVersion, identityVersion: input.identityVersion, horizonSec: 86400,
          cutBlock: input.cut.cursor.blockNumber, acquisitionSequence: input.cut.acquisitionSequence } });
      }
    }));
  }
  /**
   * Validate a first-party relative URL and evidence IDs, then append a correction for an existing
   * measured miss under the Scoreboard lock. Host caller authorizes publication; missing miss or
   * invalid input/storage failures reject.
   */
  async attachPostMortem(orderId: string, url: string, evidenceIds: unknown) {
    const evidence = ids.parse(evidenceIds);
    if (!/^\/[a-z0-9/_-]+$/.test(url)) throw new Error('Post-mortem must be a first-party relative path');
    await this.db.tx(async db=>{
    await db.sql.query("SELECT pg_advisory_xact_lock(hashtext('scoreboard'))");
    const prior = (await db.sql.query<{ data: ScoreboardRow }>('SELECT data FROM scoreboard_records WHERE source_key=$1', [`miss:${z.uuid().parse(orderId)}`])).rows[0];
    if (!prior) throw new Error('Measured miss missing');
    await this.row(db, `post-mortem:${orderId}:${key({ url, evidence })}`, { ...prior.data,
      detail: { ...prior.data.detail, event: 'post_mortem', correctionOf: prior.data.id, postMortemStatus: 'published', postMortemUrl: url } });
    });
  }
  /**
   * Consume durable incident evidence under the Scoreboard lock and return a bounded category page
   * at a frozen sequence/time cursor. Compute counters only with contiguous current coverage and
   * apply milestone phase gating; unavailable dependencies remain explicit. Public reader; invalid
   * cursors or SQL/schema failures reject.
   */
  async list(kind: ScoreboardKind = 'calls', cursor?: string, limit = 50) {
    const decoded = decodeCursor(cursor, `scoreboard:${kind}`);
    if (decoded && (decoded.length !== 3 || decoded.some(v => typeof v !== 'string' || !/^\d+$/.test(v)))) throw new InputError('Invalid scoreboard cursor');
    const asOf = decoded ? Number(decoded[2]) : this.now();
    if(!Number.isSafeInteger(asOf) || asOf>this.now())throw new InputError('Invalid scoreboard time');
    return this.marked(() => this.db.tx(async db => {
      await db.sql.query("SELECT pg_advisory_xact_lock(hashtext('scoreboard'))");
      if (!this.background) await this.consume(db);
      const max = (await db.sql.query<{ n: string }>('SELECT coalesce(max(seq),0) AS n FROM scoreboard_records')).rows[0]!.n;
      const snapshot = decoded ? String(decoded[0]) : String(max), before = decoded ? String(decoded[1]) : (BigInt(snapshot) + 1n).toString();
      if (BigInt(snapshot) > BigInt(max) || BigInt(before) > BigInt(snapshot) + 1n) throw new InputError('Invalid scoreboard snapshot');
      // Only the honeypot counters need every row of their kind; the page itself is read by kind and bounded.
      const fills = (await db.sql.query<RecordRow<ScoreboardRow>>(`SELECT seq,source_key,data FROM scoreboard_records WHERE category='row' AND seq<=$1
        AND data->>'kind' IN ('honeypots_refused','honeypots_missed') ORDER BY seq DESC`, [snapshot])).rows;
      const coverage = (await db.sql.query<{ data: Coverage }>("SELECT data FROM scoreboard_records WHERE category='coverage' AND seq<=$1 ORDER BY data->>'from'", [snapshot])).rows.map(r => coverageSchema.parse(r.data));
      const measure = (metric: 'refused' | 'missed') => {
        const periods = coverage.filter(p => p[metric]);
        if (!periods.length) return { availability: unavailable('monitoring_missing'), since: null, value: null };
        let through = Date.parse(periods[0]!.through); const since = periods[0]!.from;
        for (const p of periods.slice(1)) { if (Date.parse(p.from) > through) return { availability: unavailable('coverage_gap'), since, value: null }; through = Math.max(through, Date.parse(p.through)); }
        if (through < asOf) return { availability: unavailable('coverage_gap'), since, value: null };
        const target = metric === 'refused' ? 'honeypots_refused' : 'honeypots_missed';
        const retracted = new Set(fills.filter(r=>r.data.detail.counterEffect==='retracted').map(r=>r.data.detail.correctionOf));
        const value = fills.filter(r => r.data.kind === target && !r.data.detail.correctionOf && !retracted.has(r.data.id) && Date.parse(r.data.ts) >= Date.parse(since) && Date.parse(r.data.ts) <= through).length;
        return { availability: { status: 'observed' as const, since, through: new Date(through).toISOString() }, since, value };
      };
      const refused = measure('refused'), missed = measure('missed');
      const gated = !['token_live', 'tiers'].includes(this.phase());
      const rows = gated && kind === 'milestones' ? [] : (await db.sql.query<RecordRow<ScoreboardRow>>(`SELECT seq,source_key,data FROM scoreboard_records
        WHERE category='row' AND seq<=$1 AND seq<$2 AND data->>'kind'=$3 ORDER BY seq DESC LIMIT $4`, [snapshot, before, kind, limit + 1])).rows;
      const exists = async (where: string) => (await db.sql.query(`SELECT 1 FROM scoreboard_records WHERE category='row' AND seq<=$1 AND ${where} LIMIT 1`, [snapshot])).rows.length > 0;
      const observed = { status: 'observed' as const, through: new Date(this.now()).toISOString() };
      return ScoreboardResponseSchema.parse({ rows: rows.slice(0, limit).map(r => r.data), cursor: rows.length > limit ? encodeCursor(`scoreboard:${kind}`, [snapshot, String(rows[limit - 1]!.seq), String(asOf)]) : null,
        snapshot, counters: { refused: refused.value, missed: missed.value, since: refused.since && missed.since && refused.since === missed.since ? refused.since : null },
        availability: { refused: refused.availability, missed: missed.availability, forecasts: unavailable('forecast_dependency'),
          grades: await exists("data->'detail'->>'event'='grade'") ? observed : unavailable('outcomes_unaccepted'),
          cohort: await exists("data->>'kind'='cohort'") ? observed : unavailable('outcomes_unaccepted'), milestones: unavailable(gated ? 'd0_gated' : 'milestones_unaccepted') } });
    }));
  }
}
