import { describe, expect, it } from 'vitest';
// @ts-expect-error The offline collector is an existing-tooling JavaScript command.
import { scanLatencyReport } from '../../../scripts/scan-latency.mjs';
const candidate='a'.repeat(40);
const sample={coin:`0x${'1'.repeat(40)}`,venue:'pons',discoveredAt:1000,engineStartedAt:1100,firstVerdictAt:1120,criticalCompleteAt:5900,verdictId:'fixture-verdict'};
const input={candidate,source:'staging',eligibleCount:1,samples:[sample]};
describe('Fast Scan complete-cohort latency gate',()=>{
  it('passes complete staging scans within 5 seconds, excluding fast first results',()=>{
    expect(scanLatencyReport(input,candidate)).toMatchObject({passed:true,queueDelayP95Ms:100,firstVerdictP95Ms:120,pairToCompleteVerdictP95Ms:4900});
    expect(scanLatencyReport({...input,samples:[{...sample,criticalCompleteAt:6001}]},candidate)).toMatchObject({passed:false,pairToCompleteVerdictP95Ms:5001});
    expect(scanLatencyReport({...input,samples:[{...sample,criticalCompleteAt:null}]},candidate)).toMatchObject({passed:false,incomplete:1,pairToCompleteVerdictP95Ms:null});
  });
  it('retains missing-check denominators and refuses fixtures as staging evidence',()=>{
    const second={...sample,coin:`0x${'2'.repeat(40)}`,criticalCompleteAt:null};
    expect(scanLatencyReport({...input,eligibleCount:2,samples:[sample,second]},candidate)).toMatchObject({passed:false,eligible:2,completed:1,incomplete:1});
    expect(scanLatencyReport({...input,source:'fixture'},candidate).passed).toBe(false);
  });
  it('rejects wrong revisions, omitted population, duplicate targets and invalid clocks',()=>{
    expect(()=>scanLatencyReport(input,'b'.repeat(40))).toThrow('Candidate mismatch');
    expect(()=>scanLatencyReport({...input,eligibleCount:2},candidate)).toThrow();
    expect(()=>scanLatencyReport({...input,eligibleCount:2,samples:[sample,sample]},candidate)).toThrow();
    expect(()=>scanLatencyReport({...input,samples:[{...sample,firstVerdictAt:0}]},candidate)).toThrow();
    expect(()=>scanLatencyReport({...input,samples:[{...sample,verdictId:null}]},candidate)).toThrow();
  });
});
