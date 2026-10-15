import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { keccak256, stringToHex } from 'viem';
import { canonicalize, AddressSchema, VoteBatchSchema, validatePersonaBatch, type PersonaVote, type ProviderId } from '@eko/shared';
import { currentReceiptAnchor, publishReceipt, type ChainDb } from '@eko/db';
import { evaluateSwarmFunnel, swarmCacheKey, swarmSnapshotHash, swarmPrompt, PERSONA_SET_V1, SWARM_PERSONA_SET_HASH,
  type SwarmFunnelInput } from '@eko/engines';
import { reserveSwarmBudget } from './budget.js';
import { ProviderError, type InferenceRequest, type InferenceResult } from './types.js';
import type { ProviderRegistry } from './registry.js';

const route = z.strictObject({ model: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9/._:-]*$/),
  // Operator's verified upper cost bound includes route fees and all input/output tokens.
  maxUsd: z.number().positive().max(33) });
const family = z.strictObject({ openrouter: route, ppq: route.extend({ provider: z.enum(['anthropic','openai','google','xai','deepseek','mistral','groq']) }) });
export const SwarmModelsSchema = z.strictObject({ version: z.string().min(1).max(100), verified: z.literal(true),
  luna: family, sol: family, opus: family });
export type SwarmModels = z.infer<typeof SwarmModelsSchema>;
export type SwarmConfig = { enabled: boolean; aiDailyUsd: number; dailyUsd: number; perCoinUsd: number; models: SwarmModels | null };
/**
 * Parse host Swarm settings, cap daily spend at 33 and require verified model routing metadata.
 * Missing/invalid models become null and invalid budgets become zero; only literal true enables
 * the flag. No provider client starts.
 */
export function loadSwarmConfig(env: Record<string,string | undefined>): SwarmConfig {
  const number = (value: string | undefined, fallback: number) => {
    const n = value === undefined ? fallback : Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  let models: SwarmModels | null = null;
  try { models = SwarmModelsSchema.parse(JSON.parse(env.SWARM_MODELS ?? 'null')); } catch { /* Missing/unverified slugs disable inference. */ }
  return { enabled: env.SWARM_ENABLED === 'true', aiDailyUsd: number(env.AI_DAILY_BUDGET_USD,0),
    dailyUsd: Math.min(33,number(env.SWARM_DAILY_BUDGET_USD,0)), perCoinUsd: number(env.SWARM_PER_COIN_BUDGET_USD,0.25), models };
}
export interface SwarmRegistry extends Pick<ProviderRegistry,'infer'|'isConfigured'|'route'> {}
type Sample = { vote: PersonaVote; model: string; provider: string; asOfBlock: number; snapshotHash: string }
interface Cached { samples: Sample[]; sourceJob: string }
interface Job { id: string; coin: string; input: SwarmFunnelInput; cache_key: string }
const hash = (value: unknown) => keccak256(stringToHex(canonicalize(value)));
const version = `v${PERSONA_SET_V1.version}`;

/** Wilson 90% interval, including extreme proportions. */
export function swarmInterval(samples: readonly Sample[]) {
  const n = samples.length, p = samples.filter(s => s.vote.action === 'ape').length / n, z = 1.6448536269514722;
  const halfWidth = z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / (1+z*z/n);
  return { apeShare:p, halfWidth, count:n };
}

/** No timer-driven forecasts and no Guard/Radar writer. Call enqueue on meaningful
 * card changes, then drain from the Swarm role. Providers are injected; this
 * packet starts no live client. Unknown in-flight work fails closed on recovery.
 */
export class SwarmWorker {
  /**
   * Wire storage, injected inference registry, live configuration and evidence/clock/head options.
   * Host-only construction starts no timer or provider call; live inference additionally requires
   * approvedLive.
   */
  constructor(readonly db: ChainDb, readonly registry: SwarmRegistry, readonly config: () => SwarmConfig,
    readonly options: { evidence: 'fixture' | 'live'; approvedLive?: boolean; headBlock: () => Promise<number>;
      now?: () => number; random?: () => number; maxQueued?: number } ) {
    // TODO(spec): Queue capacity and abandonment age are unspecified. Use 100
    // active jobs and five minutes without a call heartbeat; never replay paid work.
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private async log(job: Job, outcome: string, fields: { provider?: string; model?: string; reservation?: string;
    result?: InferenceResult; code?: string; cost?: number } = {}) {
    await this.db.sql.query(`INSERT INTO inference_runs(bot_id,bot_version,provider,model,market,timeframe,started_at,outcome,
      input_tokens,output_tokens,latency_ms,est_cost_usd,error,input_hash,purpose,coin,persona_set_version,reservation_id)
      VALUES('swarm',$1,$2,$3,$4,'15m',$5,$6,$7,$8,$9,$10,$11,$12,'swarm',$4,$1,$13)`,
    [version,fields.provider ?? 'none',fields.model ?? null,job.coin,this.now(),outcome,fields.result?.inputTokens ?? null,
      fields.result?.outputTokens ?? null,fields.result ? Math.round(fields.result.latencyMs) : null,fields.cost ?? 0,fields.code ?? null,job.cache_key,fields.reservation ?? null]);
  }
  /**
   * Evaluate the card funnel, derive a model/evidence-bound key and enqueue bounded durable work
   * under a queue lock. Ineligible or full queues are logged and return null; SQL/input failures
   * reject. Host supplies observed card data; no inference occurs here.
   */
  async enqueue(input: SwarmFunnelInput) {
    const funnel = evaluateSwarmFunnel(input,new Set());
    if (funnel.eligible) input = {...input,coin:AddressSchema.parse(input.coin)};
    const models = this.config().models;
    const key = funnel.eligible ? swarmCacheKey(funnel.snapshotHash,hash({models,evidence:this.options.evidence})) : hash(input);
    const job: Job = { id:hash({key,asOfBlock:input.asOfBlock}),coin:input.coin,input,cache_key:key };
    if (!funnel.eligible) { await this.log(job,'skipped_funnel',{code:funnel.code}); return null; }
    const admitted = await this.db.tx(async tx => {
      await tx.sql.query('LOCK TABLE swarm_jobs IN SHARE ROW EXCLUSIVE MODE');
      const count = (await tx.sql.query<{n:string}>("SELECT count(*)::text AS n FROM swarm_jobs WHERE state IN ('queued','running')")).rows[0]!;
      if (Number(count.n) >= (this.options.maxQueued ?? 100)) return null;
      await tx.sql.query(`INSERT INTO swarm_jobs(id,cache_key,coin,input,state) VALUES($1,$2,$3,$4,'queued') ON CONFLICT DO NOTHING`,
        [job.id,key,input.coin,JSON.stringify(input)]);
      return job.id;
    });
    if (!admitted) await this.log(job,'skipped_queue');
    return admitted;
  }
  /** Startup recovery never replays possibly billed calls. Operator can enqueue
   * a new observed card revision; outstanding reservations remain consumed. */
  async recoverInterrupted(olderThanMs = 300000) {
    const jobs = (await this.db.sql.query<Job>(`UPDATE swarm_jobs SET state='failed',finished_at=clock_timestamp(),result='{"code":"interrupted"}'
      WHERE state='running' AND started_at < clock_timestamp()-$1*interval '1 millisecond' RETURNING *`, [olderThanMs])).rows;
    for (const job of jobs) await this.log(job,'error',{code:'interrupted'});
    return jobs.length;
  }
  /**
   * Process at most limit queued jobs through runNext and return the claimed count. Host role
   * supplies the bound; no scheduling timer starts and storage failures propagate.
   */
  async drain(limit = 100) {
    let n = 0;
    while (n < limit && await this.runNext()) n++;
    return n;
  }
  /**
   * Claim one queued job with SKIP LOCKED, enforce configuration/funnel/cache/budget gates and
   * persist a bounded result or failure code. Return false for an empty queue, true for claimed
   * work; paid calls use the injected registry. Storage failures propagate and uncertain
   * interrupted work is not replayed.
   */
  async runNext() {
    const job = await this.db.tx(async tx => (await tx.sql.query<Job>(`UPDATE swarm_jobs SET state='running',started_at=clock_timestamp()
      WHERE id=(SELECT id FROM swarm_jobs WHERE state='queued' ORDER BY queued_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0]);
    if (!job) return false;
    try {
      const result = await this.run(job);
      await this.db.sql.query("UPDATE swarm_jobs SET state='done',finished_at=clock_timestamp(),result=$2 WHERE id=$1 AND state='running'",[job.id,JSON.stringify(result)]);
    } catch (error) {
      // Persist only fixed codes, never provider prose or hostile model output.
      const code = error instanceof ProviderError ? error.code : 'worker_error';
      await this.log(job,'error',{code});
      await this.db.sql.query("UPDATE swarm_jobs SET state='failed',finished_at=clock_timestamp(),result=$2 WHERE id=$1 AND state='running'",[job.id,JSON.stringify({code})]);
    }
    return true;
  }
  private available(config: SwarmConfig) {
    return config.enabled && config.models && config.aiDailyUsd > 0 && config.dailyUsd > 0 && config.perCoinUsd > 0
      && (this.options.evidence === 'fixture' || this.options.approvedLive === true);
  }
  private async run(job: Job) {
    const config = this.config(), funnel = evaluateSwarmFunnel(job.input,new Set());
    if (!this.available(config)) { await this.log(job,'skipped_disabled'); return {code:'disabled'}; }
    if (!funnel.eligible) { await this.log(job,'skipped_funnel',{code:funnel.code}); return {code:funnel.code}; }
    // A config change after enqueue invalidates the queued candidate rather than reinterpreting its model versions.
    if (job.cache_key !== swarmCacheKey(funnel.snapshotHash,hash({models:config.models,evidence:this.options.evidence}))) {
      await this.log(job,'skipped_unconfigured'); return {code:'configuration_changed'};
    }
    const cached = (await this.db.sql.query<{data:Cached}>('SELECT data FROM swarm_cache WHERE cache_key=$1 ORDER BY recorded_at DESC,source_job DESC LIMIT 1',[job.cache_key])).rows[0]?.data;
    if (cached && await this.fresh(cached.samples)) {
      await this.log(job,'skipped_cache'); return this.forecast(job,cached.samples,cached.sourceJob);
    }
    await this.db.sql.query('INSERT INTO persona_sets VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[version,SWARM_PERSONA_SET_HASH,JSON.stringify(PERSONA_SET_V1)]);
    const samples: Sample[] = [];
    const ids = PERSONA_SET_V1.personas.map(p => p.id);
    for (let round = 0; round < 5; round++) {
      // TODO(spec): §8.5 mandates an initial all-Luna batch while §8.2 gives a
      // 70/20/10 mix. Apply the mix to subsequent rounds; preserve initial Luna.
      const groups: { family:'luna'|'sol'|'opus'; ids:string[] }[] = round === 0
        ? [{family:'luna',ids}] : [{family:'luna',ids:ids.slice(0,7)},...ids.slice(7,9).map(id => ({family:'sol' as const,ids:[id]})),{family:'opus',ids:[ids[9]!]}];
      for (const group of groups) {
        // Splitting one call into single+remainder with probability 1/19 gives
        // single-persona calibration 5% of Luna calls in expectation.
        const calls = group.family === 'luna' && (this.options.random?.() ?? Math.random()) < 1/19 ? [group.ids.slice(0,1),group.ids.slice(1)].filter(ids => ids.length) : [group.ids];
        for (const personas of calls) {
          const batch = await this.batch(job,group.family,personas);
          if (!batch) return {code:'incomplete'};
          for (const sample of batch) {
            await this.db.sql.query('INSERT INTO persona_votes VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [randomUUID(),job.id,samples.length,sample.model,sample.provider,sample.asOfBlock,sample.snapshotHash,JSON.stringify(sample.vote)]);
            samples.push(sample);
          }
        }
      }
      const interval = swarmInterval(samples);
      if (round === 0 && (interval.apeShare < 0.3 || interval.apeShare > 0.7) || interval.halfWidth < 0.1) break;
    }
    if (!this.available(this.config()) || !await this.fresh(samples)) { await this.log(job,'rejected',{code:'stale_or_disabled'}); return {code:'stale_or_disabled'}; }
    return this.forecast(job,samples,job.id);
  }
  private async fresh(samples: Sample[]) {
    const head = await this.options.headBlock();
    return samples.length >= 10 && samples.length <= 50 && samples.every(s => Number.isSafeInteger(head) && head >= s.asOfBlock && head-s.asOfBlock <= 600);
  }
  private async batch(job: Job, familyName: 'luna'|'sol'|'opus', personas: string[]): Promise<Sample[] | null> {
    const conf = this.config(), familyConfig = conf.models![familyName];
    const prompt = swarmPrompt(job.coin,job.input.naiveView,job.input.asOfBlock,personas);
    const request = { ...prompt,schema: z.toJSONSchema(VoteBatchSchema),schemaName:'swarm_votes',timeoutMs:30000 };
    for (const routeName of ['openrouter','ppq'] as const) {
      const current = this.config();
      if (!this.available(current) || canonicalize(current.models) !== canonicalize(conf.models)) { await this.log(job,'skipped_disabled'); return null; }
      const r = familyConfig[routeName], provider: ProviderId = routeName === 'openrouter' ? 'openrouter' : familyConfig.ppq.provider;
      if (!this.registry.isConfigured(provider) || (routeName === 'ppq' && this.registry.route(provider).route !== 'gateway')) {
        await this.log(job,'skipped_unconfigured',{provider,model:r.model});
        // Missing primary configuration disables inference, rather than silently enabling a paid fallback.
        return null;
      }
      const reservation = randomUUID();
      if (!await reserveSwarmBudget(this.db,{id:reservation,jobId:job.id,coin:job.coin,maxUsd:r.maxUsd,now:this.now(),
        aiDailyUsd:current.aiDailyUsd,dailyUsd:current.dailyUsd,perCoinUsd:current.perCoinUsd})) {
        await this.log(job,'skipped_budget',{provider,model:r.model}); return null;
      }
      await this.log(job,'started',{provider,model:r.model,reservation});
      let result: InferenceResult;
      try { result = await this.registry.infer(provider,{...request,model:r.model} satisfies InferenceRequest,{retry:false}); }
      catch (error) {
        const code = error instanceof ProviderError ? error.code : 'unknown';
        await this.log(job,'error',{provider,model:r.model,reservation,code,cost:r.maxUsd});
        if (routeName === 'openrouter' && ['overloaded','quota','network','timeout'].includes(code)) continue;
        return null;
      }
      const cost = result.costUsd == null ? r.maxUsd : result.costUsd;
      const valid = validatePersonaBatch(result.output,{snapshotHash:swarmSnapshotHash(job.coin,job.input.naiveView),
        asOfBlock:job.input.asOfBlock,headBlock:await this.options.headBlock(),personas});
      const code = !route.shape.model.safeParse(result.model).success ? 'model_metadata' : !Number.isFinite(cost) || cost < 0 || cost > r.maxUsd ? 'cost_bound' :
        result.outputTokens != null && result.outputTokens > 600 ? 'token_bound' : !valid.ok ? valid.code : null;
      await this.log(job,code ? 'rejected' : 'ok',{provider,model:result.model,reservation,result,code:code ?? undefined,cost:Number.isFinite(cost) && cost >= 0 ? cost : r.maxUsd});
      if (code || !valid.ok) return null;
      return valid.output.votes.map(vote => ({vote,model:result.model,provider:routeName,asOfBlock:valid.output.as_of_block,snapshotHash:valid.output.snapshot_hash}));
    }
    return null;
  }
  private async forecast(job: Job, samples: Sample[], sourceJob: string) {
    return this.db.tx(async tx => {
      if (!this.available(this.config()) || job.cache_key !== swarmCacheKey(swarmSnapshotHash(job.coin,job.input.naiveView),hash({models:this.config().models,evidence:this.options.evidence})))
        throw new ProviderError('unconfigured','Swarm disabled or configuration changed');
      // Fence recovery before publishing: abandoned work cannot produce a forecast.
      const state = (await tx.sql.query<{state:string}>('SELECT state FROM swarm_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0]?.state;
      if (state !== 'running') throw new Error('Job no longer running');
      const id = `swarm-${job.id}`, recordedAt = new Date(this.now()).toISOString();
      const deterministicInput = { evidence:this.options.evidence,coin:job.coin,naiveView:job.input.naiveView,asOfBlock:job.input.asOfBlock,
        personaSetHash:SWARM_PERSONA_SET_HASH,models:this.config().models,samples:samples.map(s => ({...s})),sourceJob };
      const decision = {...swarmInterval(samples),beta:true,swarmRanking:false};
      await publishReceipt(tx,'swarm',{schemaVersion:'public-receipt-1',canonicalization:'jcs-rfc8785/v1',receiptId:id,revisionId:id,
        kind:'forecast',chainId:4663,coin:AddressSchema.parse(job.coin),recordedAt,modelIds:[...new Set(samples.map(s => s.model))],personaSetVersion:version,
        cardSchemaVersion:'swarm-naive-1',rulesVersion:'swarm-funnel-1',outputSchemaVersion:'swarm-forecast-1',
        snapshotHash:hash(deterministicInput),deterministicInput,decision,window:{kind:'forecast',startsAt:'commit_block',durationSec:900},supersedes:null,reorgOf:null});
      await tx.sql.query('INSERT INTO forecasts VALUES($1,$2,$3,$4,$5,$6,$1)',[id,job.id,job.coin,job.input.asOfBlock,recordedAt,JSON.stringify(decision)]);
      const result = {id,...decision,window:{status:'pending' as const}};
      await tx.sql.query("UPDATE swarm_jobs SET state='done',finished_at=clock_timestamp(),result=$2 WHERE id=$1",[job.id,JSON.stringify(result)]);
      await tx.sql.query('INSERT INTO swarm_cache(cache_key,source_job,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[job.cache_key,sourceJob,JSON.stringify({samples,sourceJob})]);
      return result;
    });
  }
  /**
   * Return null for an absent forecast, pending for an unanchored receipt, or its current anchored
   * fifteen-minute window. Read-only lookup; SQL/anchor verification failures propagate.
   */
  async outcomeWindow(id: string) {
    const exists = (await this.db.sql.query('SELECT id FROM forecasts WHERE id=$1',[id])).rows.length;
    if (!exists) return null;
    const anchor = await currentReceiptAnchor(this.db,id);
    return anchor ? {status:'anchored' as const,startBlock:anchor.blockNumber,durationSec:900,txHash:anchor.txHash} : {status:'pending' as const};
  }
}
