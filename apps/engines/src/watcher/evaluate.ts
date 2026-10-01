import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AddressSchema, CENSUS_GATE_MAX_AGE_MS, censusGateAccepted } from '@eko/shared';
import { censusGate, flowModel, type ChainDb } from '@eko/db';
import { FP_MODEL, resolveFingerprintLabel } from './score.js';

const share = z.number().min(0).max(1).nullable();
const nonnegative = z.number().nonnegative().nullable();
export const EvaluationFeaturesSchema = z.strictObject({
  swaps:z.number().int().nonnegative(), aa4337Share:share, delegated7702:z.boolean().nullable(), paymasterShare:share,
  routerTopShare:share, routerKnownAgent:z.boolean().nullable(), calldataShapeShare:share,
  intervalCv:nonnegative, secOfMinuteEntropy:nonnegative, hourEntropy:nonnegative, reactionP10Blocks:nonnegative,
  sizeRepeatShare:share, gasLimitRepeatShare:share, orbioCredit:z.boolean().nullable(), txEntropy:nonnegative,
  missing:z.array(z.string()),
});
const modelSchema = z.strictObject({version:z.string().min(1),threshold:z.number().min(0.75).max(1),bias:z.number(),
  w:z.strictObject(Object.fromEntries(Object.keys(FP_MODEL.w).map(key=>[key,z.number()])) as Record<keyof typeof FP_MODEL.w,z.ZodNumber>)});
const observation = {wallet:AddressSchema.transform(value=>value.toLowerCase()),heldOut:z.literal(true),features:EvaluationFeaturesSchema};
const review = z.strictObject({reviewer:z.string().regex(/^reviewer-[a-z0-9-]+$/),label:z.enum(['agent','human'])});
export const CensusEvaluationSchema = z.strictObject({
  kind:z.literal('census-wallet-labels-v1'),
  model:modelSchema,
  trainingWallets:z.array(AddressSchema.transform(value=>value.toLowerCase())),
  rows:z.array(z.discriminatedUnion('source',[
    z.strictObject({...observation,source:z.literal('declared'),declared:z.literal(true)}),
    z.strictObject({...observation,source:z.literal('reviewed'),reviews:z.tuple([review,review])}),
  ])).min(1),
});
export type CensusEvaluationInput = z.input<typeof CensusEvaluationSchema>;
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function wilsonLower(successes:number,total:number) {
  if(total===0)return 0;
  const z95=1.959963984540054,z2=z95*z95,p=successes/total;
  return (p+z2/(2*total)-z95*Math.sqrt(p*(1-p)/total+z2/(4*total*total)))/(1+z2/total);
}
/** Agent truth is supplied separately; Guard buyer-harm labels are never inputs. */
export function evaluateCensus(input:unknown,evaluatedAt=Date.now()) {
  const data=CensusEvaluationSchema.parse(input);
  if(!Number.isFinite(evaluatedAt))throw new Error('Invalid evaluation time');
  const seen=new Set<string>(),training=new Set(data.trainingWallets);
  let declared=0,agents=0,humans=0,disagreements=0,tp=0,fp=0,fn=0;
  const rows=[...data.rows].sort((a,b)=>a.wallet.localeCompare(b.wallet)).map(row=>row.source==='reviewed'
    ? {...row,reviews:[...row.reviews].sort((a,b)=>a.reviewer.localeCompare(b.reviewer))} : row);
  for(const row of rows) {
    if(seen.has(row.wallet))throw new Error('Duplicate evaluation wallet');
    if(training.has(row.wallet))throw new Error('Training wallet in held-out evaluation');
    seen.add(row.wallet);
    let truth:boolean;
    if(row.source==='declared') {
      if(row.features.swaps<5)throw new Error('Held-out declared wallet needs at least five swaps');
      declared++;truth=true;
    } else {
      if(row.reviews[0].reviewer===row.reviews[1].reviewer)throw new Error('Two distinct reviewers required');
      if(row.reviews[0].label!==row.reviews[1].label){disagreements++;continue;}
      truth=row.reviews[0].label==='agent';if(truth)agents++;else humans++;
    }
    // Classify held-out declared wallets without the registry override, measuring likely_agent.
    const prediction=resolveFingerprintLabel(row.features,{model:data.model});
    const positive=prediction.label==='likely_agent'&&(prediction.tier==='high'||prediction.tier==='medium');
    if(positive){if(truth)tp++;else fp++;}else if(truth)fn++;
  }
  const predictedAgents=tp+fp,value=predictedAgents?tp/predictedAgents:0;
  const evidence={declared,agents,humans,disagreements,predictedAgents};
  const modelHash=digest({model:data.model,trainingWallets:[...training].sort()});
  const datasetHash=digest({kind:data.kind,rows});
  const gate={metric:'likely_agent_precision' as const,value,wilsonLower:wilsonLower(tp,predictedAgents),recall:tp+fn?tp/(tp+fn):0,
    threshold:0.90,modelVersion:data.model.version,modelHash,datasetHash,evidence,
    evaluatedAt:new Date(evaluatedAt).toISOString(),expiresAt:new Date(evaluatedAt+CENSUS_GATE_MAX_AGE_MS).toISOString()};
  return {gate,passed:censusGateAccepted(gate,evaluatedAt),counts:{truePositives:tp,falsePositives:fp,falseNegatives:fn},
    id:digest({modelHash,datasetHash,evaluatedAt:gate.evaluatedAt})};
}
export async function importCensusEvaluation(db:ChainDb,input:unknown,now=Date.now()) {
  const result=evaluateCensus(input,now),g=result.gate;
  await db.tx(async tx=>{
    await tx.sql.query('LOCK TABLE watcher_flow_model IN SHARE MODE');
    if(await flowModel(tx)!==g.modelVersion)throw new Error('Evaluation model is not the current model');
    const latest=await censusGate(tx,g.modelVersion);
    if(latest.evaluatedAt&&Date.parse(latest.evaluatedAt)>now)throw new Error('Evaluation predates the latest gate');
    await tx.sql.query(`INSERT INTO eval_gates(id,metric,model_version,value,wilson_lower,recall,evaluated_at,expires_at,model_hash,dataset_hash,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
      [result.id,g.metric,g.modelVersion,g.value,g.wilsonLower,g.recall,g.evaluatedAt,g.expiresAt,g.modelHash,g.datasetHash,JSON.stringify(g.evidence)]);
  });
  return result;
}
