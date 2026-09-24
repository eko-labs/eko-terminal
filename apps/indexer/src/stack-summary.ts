/** Only source locations and known code symbols survive; never log raw stack lines. */
const symbols:Record<string,readonly string[]>={
  'log-head.ts':['LogHeadFollower.anchor','LogHeadFollower.rollback','LogHeadFollower.query','LogHeadFollower.logs','LogHeadFollower.tick','LogHeadFollower.tickOnce','LogHeadFollower.processTick','LogHeadFollower.fetchWindow','LogHeadFollower.applyWindow','LogHeadFollower.run'],
  'decode.ts':['BlockDecoder.prefetch','BlockDecoder.prepare','BlockDecoder.collect','BlockDecoder.write','BlockDecoder.scopeForBlock','BlockDecoder.discoverV3Pools'],
  'rows.ts':['BlockRows.flush'], 'cli.ts':['main'], 'head.ts':['HeadFollower.ingest','HeadFollower.rollback','HeadFollower.run'],
  'backfill.ts':['PonsBackfill.run'], 'enrich.ts':['enrichSenders'], 'concurrency.ts':['Semaphore.run','settle'],
};
export function stackSummary(error:unknown) {
  const frames:{function:string;file:string;line:number}[]=[],seen=new Set<unknown>();
  for(let depth=0;error&&typeof error==='object'&&depth<4&&!seen.has(error);depth++){
    seen.add(error);
    const current=error as {stack?:unknown;cause?:unknown};
    if(typeof current.stack==='string')for(const line of current.stack.split('\n').slice(1,40)){
      if(/https?:\/\/|[?&#]/i.test(line))continue;
      const match=line.match(/(?:^\s*at\s+(?:async\s+)?(?:(\S+)\s+\()?).*?\/(apps\/indexer\/src\/([a-z-]+\.ts)):(\d+):\d+\)?$/);
      if(!match||!symbols[match[3]])continue;
      const name=symbols[match[3]].includes(match[1])?match[1]:'anonymous';
      const frame={function:name,file:match[2],line:Number(match[4])};
      if(!frames.some(f=>f.function===frame.function&&f.file===frame.file&&f.line===frame.line))frames.push(frame);
      if(frames.length===8)return frames;
    }
    error=current.cause;
  }
  return frames;
}
