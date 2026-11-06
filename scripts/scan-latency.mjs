import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Task 087 consumes this complete cohort report; missing results remain in its denominator. */
export function scanLatencyReport(input, candidate) {
  if(!/^[a-f0-9]{40}$/.test(candidate) || input.candidate!==candidate)throw new Error('Candidate mismatch');
  if(!['fixture','staging'].includes(input.source) || !Array.isArray(input.samples) ||
    !Number.isInteger(input.eligibleCount) || input.eligibleCount!==input.samples.length || !input.samples.length)
    throw new Error('Complete eligible discovery cohort required');
  const seen=new Set(),complete=[],queue=[],first=[],groups={};
  for(const row of input.samples) {
    if(!/^0x[0-9a-f]{40}$/.test(row.coin) || seen.has(row.coin) || !Number.isSafeInteger(row.discoveredAt) || row.discoveredAt<0 ||
      !['pons','uniswap_v3','uniswap_v4','other'].includes(row.venue))throw new Error('Invalid discovery sample');
    seen.add(row.coin);
    const group=groups[row.venue] ??= {eligible:0,complete:0};group.eligible++;
    for(const key of ['engineStartedAt','firstVerdictAt','criticalCompleteAt']) {
      if(row[key]!=null && (!Number.isSafeInteger(row[key]) || row[key]<row.discoveredAt))throw new Error('Invalid stage clock');
    }
    if(row.engineStartedAt!=null)queue.push(row.engineStartedAt-row.discoveredAt);
    if(row.firstVerdictAt!=null)first.push(row.firstVerdictAt-row.discoveredAt);
    if(row.criticalCompleteAt!=null) {
      if(row.engineStartedAt==null || row.firstVerdictAt==null || row.engineStartedAt>row.firstVerdictAt || row.criticalCompleteAt<row.firstVerdictAt || !row.verdictId)throw new Error('Unpersisted complete result');
      complete.push(row.criticalCompleteAt-row.discoveredAt);group.complete++;
    }
  }
  const quantile=values=>values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(.95*values.length)-1] : null;
  const p95=quantile(complete),missing=input.eligibleCount-complete.length;
  return {candidate,source:input.source,eligible:input.eligibleCount,completed:complete.length,incomplete:missing,byVenue:groups,
    firstVerdictP95Ms:quantile(first),queueDelayP95Ms:quantile(queue),pairToCompleteVerdictP95Ms:p95,
    targetMs:5000,passed:input.source==='staging' && missing===0 && p95!==null && p95<=5000,
    approval:'unaccepted',notes:['First verdict and HTTP response times do not satisfy the completion gate.','Task 087 owns staging cohort provenance, collection window and launch acceptance.']};
}
async function main() {
  const [inputPath,candidate,outputPath]=process.argv.slice(2);
  if(!inputPath || !candidate || !outputPath)throw new Error('Usage: node scripts/scan-latency.mjs <cohort.json> <candidate-sha> <report.json>');
  const report=scanLatencyReport(JSON.parse(await readFile(inputPath,'utf8')),candidate);
  await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({candidate,eligible:report.eligible,complete:report.completed,incomplete:report.incomplete,p95Ms:report.pairToCompleteVerdictP95Ms,passed:report.passed}));
  process.exitCode=report.passed ? 0 : 1;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Invalid scan latency evidence or invocation.');process.exitCode=1;});
