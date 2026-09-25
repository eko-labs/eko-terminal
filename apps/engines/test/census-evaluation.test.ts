import { describe, expect, it } from 'vitest';
import { censusGateAccepted, CENSUS_GATE_MAX_AGE_MS } from '@eko/shared';
import { evaluateCensus, wilsonLower } from '../src/watcher/evaluate.js';
import { censusEvaluationFixture, evaluationFeatures, evaluationTime } from './census-fixture.js';

describe('Census reviewed-label evaluation (synthetic evidence)',()=>{
  it('runs the fingerprint classifier without declaring every held-out registry wallet positive',()=>{
    const input=censusEvaluationFixture();input.rows[0].features=evaluationFeatures(false);
    const result=evaluateCensus(input,evaluationTime);
    expect(result.gate.evidence).toEqual({declared:1,agents:200,humans:300,disagreements:0,predictedAgents:200});
    expect(result.counts).toEqual({truePositives:200,falsePositives:0,falseNegatives:1});
    expect(result.gate.value).toBe(1);expect(result.gate.recall).toBeCloseTo(200/201);expect(result.gate.wilsonLower).toBeCloseTo(0.98115467);
    expect(result.passed).toBe(true);
    expect(censusGateAccepted(result.gate,evaluationTime+CENSUS_GATE_MAX_AGE_MS)).toBe(false);
    expect(result.gate.modelHash).toMatch(/^[a-f0-9]{64}$/);expect(result.gate.datasetHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('excludes disagreements from both metrics and the minimum reviewed sets',()=>{
    const input=censusEvaluationFixture(),row=input.rows[1];
    if(row.source!=='reviewed')throw new Error('fixture');row.reviews[1].label='human';
    const result=evaluateCensus(input,evaluationTime);
    expect(result.gate.evidence).toMatchObject({agents:199,humans:300,disagreements:1,predictedAgents:200});
    expect(result.gate.value).toBe(1);expect(result.passed).toBe(false);
  });
  it('reports recall without gating it, and gates precision at the inclusive threshold',()=>{
    const input=censusEvaluationFixture();input.rows[0].features=evaluationFeatures(false);
    for(let n=1;n<=200;n++)input.rows[n].features=evaluationFeatures(n<=9);
    input.rows[201].features=evaluationFeatures(true);
    let result=evaluateCensus(input,evaluationTime);
    expect(result.gate.value).toBe(0.90);expect(result.gate.recall).toBeCloseTo(9/201);expect(result.passed).toBe(true);
    input.rows[202].features=evaluationFeatures(true);result=evaluateCensus(input,evaluationTime);
    expect(result.gate.value).toBeCloseTo(9/11);expect(result.passed).toBe(false);
  });
  it('requires held-out nonduplicate wallets, two distinct reviewers and sufficient declared activity',()=>{
    const duplicate=censusEvaluationFixture();duplicate.rows.push(duplicate.rows[0]);
    expect(()=>evaluateCensus(duplicate)).toThrow('Duplicate');
    const training=censusEvaluationFixture();training.trainingWallets.push(training.rows[1].wallet);
    expect(()=>evaluateCensus(training)).toThrow('Training wallet');
    const reviewer=censusEvaluationFixture(),row=reviewer.rows[1];if(row.source!=='reviewed')throw new Error('fixture');
    row.reviews[1].reviewer=row.reviews[0].reviewer;expect(()=>evaluateCensus(reviewer)).toThrow('distinct reviewers');
    const declared=censusEvaluationFixture();declared.rows[0].features.swaps=4;expect(()=>evaluateCensus(declared)).toThrow('five swaps');
    expect(()=>evaluateCensus({...censusEvaluationFixture(),kind:'guard-buyer-harm'})).toThrow();
    expect(()=>evaluateCensus({...censusEvaluationFixture(),buyerHarmLabels:[]})).toThrow();
    const notHeldOut=censusEvaluationFixture();expect(()=>evaluateCensus({...notHeldOut,rows:[{...notHeldOut.rows[0],heldOut:false}]})).toThrow();
  });
  it('hashes model, training membership and reviewed data deterministically',()=>{
    const input=censusEvaluationFixture(),first=evaluateCensus(input,evaluationTime);
    input.rows.reverse();for(const row of input.rows)if(row.source==='reviewed')row.reviews.reverse();
    expect(evaluateCensus(input,evaluationTime)).toEqual(first);
    input.model.bias+=0.1;const model=evaluateCensus(input,evaluationTime);
    expect(model.gate.modelHash).not.toBe(first.gate.modelHash);expect(model.gate.datasetHash).toBe(first.gate.datasetHash);
    input.rows[0].features.swaps++;expect(evaluateCensus(input,evaluationTime).gate.datasetHash).not.toBe(first.gate.datasetHash);
  });
  it('does not pass a perfect but tiny dataset or an evaluation with no likely-agent predictions',()=>{
    const input=censusEvaluationFixture();input.rows=input.rows.slice(0,2);expect(evaluateCensus(input,evaluationTime).passed).toBe(false);
    const none=censusEvaluationFixture();for(const row of none.rows)row.features=evaluationFeatures(false);
    expect(evaluateCensus(none,evaluationTime)).toMatchObject({passed:false,gate:{value:0,wilsonLower:0,recall:0}});
    expect(wilsonLower(0,0)).toBe(0);expect(wilsonLower(90,100)).toBeCloseTo(0.82563434);
  });
});
