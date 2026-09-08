import { describe, expect, it, vi } from 'vitest';
import { ChainDb } from '../src/client.js';
import { rawCandidates, runRetention } from '../src/retention.js';
import { ratingWindow } from '../src/rating-retention.js';
import { retentionDb, retentionRules } from '../src/retention-control.js';

function fixture(onQuery: (sql: string, params?: unknown[]) => Record<string, unknown>[] = () => []) {
  const statements: {sql:string;params?:unknown[]}[] = [];
  const transactions: string[] = [];
  const sql = { query: async <T>(text: string, params?: unknown[]) => {
    statements.push({sql:text,params}); return {rows:onQuery(text,params) as T[]};
  } };
  return {db:new ChainDb(sql, async work=>{try {const result=await work(sql);transactions.push('commit');return result;}catch(error){transactions.push('rollback');throw error;}}),statements,transactions};
}
const options = {quoteTokens:[],dryRun:false,pauseMs:0,ratingDays:7,now:()=>0};

describe('bounded retention control', () => {
  it('halves timeouts in the pass, remembers each rule independently and grows slowly after success', async () => {
    const {db}=fixture(), result=await runRetention(db,options);
    const sizes=new Map<string,{rows:number;successes:number}>();
    const run=retentionRules({...options,batchRows:1000},result,undefined,sizes);
    const attempts:number[]=[];
    await run('slow',async (_timeLeft,size)=>{attempts.push(size);if(size>250)throw Object.assign(new Error('timeout'),{code:'57014'});});
    expect(attempts).toEqual([1000,500,250]);
    expect(result.skippedRules).toEqual([]);
    expect(result.ruleStats?.slow).toEqual({rows:0,skipped:0,timeouts:2,batchRows:250});
    await run('other',async (_t,size)=>{expect(size).toBe(1000);});
    const next=retentionRules({...options,batchRows:1000},result,undefined,sizes);
    for(let i=0;i<4;i++)await next('slow',async (_t,size)=>{expect(size).toBe(250);});
    expect(sizes.get('slow')?.rows).toBe(275);
    await next('slow',async (_t,size)=>{expect(size).toBe(275);});
  });
  it('stops retrying at the floor or deadline and counts only committed rows',async()=>{
    const {db}=fixture(), result=await runRetention(db,options);
    let clock=0;
    const run=retentionRules({...options,batchRows:128,budgetMs:3000,now:()=>clock},result);
    const attempts:number[]=[];
    await run('slow',async (_t,size)=>{attempts.push(size);clock+=1000;throw Object.assign(new Error('timeout'),{code:'57014'});});
    expect(attempts).toEqual([128,64,32]);
    expect(result.ruleStats?.slow).toEqual({rows:0,skipped:1,timeouts:3,batchRows:32});
    expect(result.skippedRules).toContain('slow');
    await run('later',async()=>{result.quoteRows+=7;});
    expect(result.ruleStats?.later?.rows).toBe(7);
  });
  it('retries the failed key window with smaller limits and preserves committed counts across passes',async()=>{
    let timeouts=0,windows=0;
    const {db,statements}=fixture(sql=>{
      if(sql.startsWith('SELECT id FROM guard_shadow_runs'))return windows++<3 ? [{id:'sample-shadow'}] : [];
      if(sql.startsWith('SELECT x.id FROM guard_shadow_runs')) {
        if(timeouts++===0)throw Object.assign(new Error('timeout'),{code:'57014'});
        return [{id:'sample-shadow'}];
      }
      if(sql.includes('gone AS (DELETE FROM guard_shadow_runs'))return [{n:'1'}];
      return [];
    });
    const first=await runRetention(db,options);
    expect(first.ratingRows?.guard_shadow_runs).toBe(2);
    expect(first.ruleStats?.guard_shadow_runs).toMatchObject({rows:2,timeouts:1,skipped:0,batchRows:500});
    await runRetention(db,options);
    expect(statements.filter(s=>s.sql.startsWith('SELECT id FROM guard_shadow_runs')).map(s=>s.sql.match(/LIMIT (\d+)/)?.[1])).toEqual(['1000','500','500','500','500']);
  });

  for(const code of ['55P03','57014']) it(`rolls back a ${code} batch, names only its rule and runs later rules`, async () => {
    const {db,statements,transactions}=fixture(sql=>{
      if(sql.startsWith('SELECT run_id,block FROM wallet_fingerprint_dependencies'))throw Object.assign(new Error('private SQL and row data'),{code});
      return [];
    });
    const result=await runRetention(db,options);
    expect(result.finished).toBe(false);
    expect(result.skippedRules).toEqual(['wallet_fingerprint_dependencies']);
    expect(transactions.filter(t=>t==='rollback')).toHaveLength(code==='57014' ? 6 : 1);
    for(const table of ['guard_shadow_runs','coin_cards','playbook_matches','verdicts']) {
      expect(statements.some(s=>s.sql.startsWith(`SELECT id FROM ${table}`) || s.sql.startsWith(`SELECT coin,valid_from_block,rules_version,playbook_id FROM ${table}`))).toBe(true);
      expect(result.ratingRows?.[table]).toBe(0);
    }
    expect(result.ratingRows?.wallet_fingerprint_dependencies).toBe(0);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('propagates every other database error',async()=>{
    const {db}=fixture(sql=>{if(sql.includes('FROM wallet_fingerprint_dependencies'))throw Object.assign(new Error('other failure'),{code:'23503'});return [];});
    await expect(runRetention(db,options)).rejects.toMatchObject({code:'23503'});
  });
  it('starts a fresh budget after a receipt step exhausts its budget',async()=>{
    let clock=0;
    const {db,statements}=fixture(sql=>{if(sql.startsWith('SELECT id,recorded_at FROM receipt_publications'))clock+=10;return [];});
    const result=await runRetention(db,{...options,budgetMs:5,now:()=>clock});
    expect(result.finished).toBe(false);
    expect(statements.some(s=>s.sql.startsWith('SELECT run_id,block FROM wallet_fingerprint_dependencies'))).toBe(true);
    expect(statements.some(s=>s.sql.startsWith('SELECT id FROM verdicts'))).toBe(true);
  });
  it('bounds the total pass while giving every rating rule its own budget',async()=>{
    const {db}=fixture();const result=await runRetention(db,options);
    let clock=0;const runRule=retentionRules({...options,budgetMs:10,passBudgetMs:25,now:()=>clock},result);
    const runs:string[]=[];
    for(const name of ['receipts','fingerprints','cards','verdicts'])await runRule(name,async timeLeft=>{runs.push(name);expect(timeLeft()).toBe(true);clock+=10;expect(timeLeft()).toBe(false);});
    expect(runs).toEqual(['receipts','fingerprints','cards']);expect(result.finished).toBe(false);
  });
  it('gives a receipt backlog thirty seconds without increasing other rules or the total pass',async()=>{
    const {db}=fixture(),result=await runRetention(db,options);
    let clock=0;const deadlines:number[]=[];
    const run=retentionRules({...options,now:()=>clock},result,budget=>deadlines.push(budget));
    await run('receipt_publications',async timeLeft=>{clock=29_999;expect(timeLeft()).toBe(true);clock=30_000;expect(timeLeft()).toBe(false);});
    await run('wallet_fingerprint_dependencies',async timeLeft=>{clock+=6_000;expect(timeLeft()).toBe(false);});
    expect(deadlines).toEqual([30_000,6_000]);
  });
  it('omits raw_cap only when both raw day windows are managed by partitions',async()=>{
    for(const configured of [{swapDays:7,transferDays:3},{swapDays:7,transferDays:3,rawPartitions:true},{swapDays:7,transferDays:3,rawPartitions:false},{swapDays:7},{transferDays:3},{}]) {
      const {db}=fixture();
      const result=await runRetention(db,{...options,rawDays:7,...configured});
      expect(result.ruleStats?.raw_cap===undefined).toBe(configured.swapDays!==undefined && configured.transferDays!==undefined);
    }
  });
  it('walks fingerprint dependencies by the existing primary key before filtering runs',async()=>{
    const {db,statements}=fixture();
    await ratingWindow(db,'wallet_fingerprint_dependencies',['run_id','block'],['text','bigint'],['sample-run','12'],1000);
    expect(statements[0]!.sql).toContain('WHERE (run_id,block)>($1::text,$2::bigint)');
    expect(statements[0]!.sql).toContain('ORDER BY run_id,block LIMIT 1000');
    expect(statements[0]!.sql).not.toContain('JOIN');
  });
  it('restricts fingerprint filtering to the key window and resumes retained prefixes across passes',async()=>{
    let clock=0;
    const {db,statements}=fixture(sql=>{
      if(sql.startsWith('SELECT run_id,block FROM wallet_fingerprint_dependencies')) {clock+=6;return [{run_id:'sample-retained',block:'2'}];}
      return [];
    });
    const configured={...options,budgetMs:5,now:()=>clock};
    await runRetention(db,configured);await runRetention(db,configured);
    const windows=statements.filter(s=>s.sql.startsWith('SELECT run_id,block FROM wallet_fingerprint_dependencies'));
    expect(windows[1]!.params).toEqual(['sample-retained','2']);
    const selection=statements.find(s=>s.sql.startsWith('SELECT x.run_id,x.block FROM wallet_fingerprint_dependencies'))!.sql;
    expect(selection).not.toContain('JOIN (VALUES');expect(selection).toContain('(x.run_id,x.block) IN (SELECT * FROM unnest(');
    expect(selection).toContain('(x.run_id,x.block)>=' );expect(selection).toContain('(x.run_id,x.block)<=' );
    expect(selection).toContain('r.id=x.run_id');expect(selection).toContain('FOR UPDATE OF x SKIP LOCKED');
  });
  it.each([false,true])('reports committed rating rows with keep-current=%s',async receiptKeepCurrent=>{
    let windows=0;
    const {db,statements}=fixture(sql=>{
      if(sql.startsWith('SELECT id FROM guard_shadow_runs') && windows++===0)return [{id:'sample-shadow'}];
      if(sql.startsWith('SELECT x.id FROM guard_shadow_runs'))return [{id:'sample-shadow'}];
      if(sql.includes('gone AS (DELETE FROM guard_shadow_runs'))return [{n:'1'}];
      if(sql.startsWith('SELECT id,recorded_at FROM receipt_publications'))return [{id:'sample-receipt',recorded_at:new Date(0)}];
      // Let the receipt loop finish after one retained window.
      if(sql.includes('(recorded_at,id)>'))return [];
      return [];
    });
    // Avoid an endless fake receipt backlog by timing just that rule out after the selection.
    let clock=0;
    const query=db.sql.query.bind(db.sql);
    db.sql.query=(async (sql:string,params?:unknown[])=>{const r=await query(sql,params);if(sql.startsWith('SELECT p.id FROM receipt_publications'))clock+=6;return r;}) as typeof db.sql.query;
    const result=await runRetention(db,{...options,receiptKeepCurrent,budgetMs:5,now:()=>clock});
    expect(result.ratingRows?.guard_shadow_runs).toBe(1);
    expect(result.tables).toContainEqual({table:'guard_shadow_runs',rows:1,estimatedBytes:0});
    expect(result.ruleStats?.receipt_publications).toMatchObject({examined:1,eligible:0});
    expect(statements.some(s=>s.sql.startsWith('SELECT p.* FROM receipt_publications'))).toBe(false);
    const receipt=statements.find(s=>s.sql.startsWith('SELECT p.id FROM receipt_publications'))!.sql;
    expect(receipt.includes('NOT EXISTS(SELECT 1 FROM coin_card_latest')).toBe(receiptKeepCurrent);
    expect(receipt.includes("c.data->'verdict'->'receipt'->>'id'=p.id")).toBe(receiptKeepCurrent);
    expect(receipt).not.toContain('publication_sequence');
    expect(receipt).not.toContain('DISTINCT');
  });
  it('drives raw candidates from bounded token identities and indexed existence probes',async()=>{
    const {db,statements}=fixture();await rawCandidates(db,10n,[],Buffer.alloc(20));
    const query=statements[0]!.sql;
    expect(query).toContain('WITH identities AS MATERIALIZED');expect(query).toContain('FROM tokens WHERE address>$3 ORDER BY address LIMIT 200');
    expect(query.indexOf('LIMIT 200')).toBeLessThan(query.indexOf('t.deployer IS NULL'));
    expect(query).toContain('address>$3');expect(query).toContain('ORDER BY address LIMIT 200');
    expect(query).toContain('x.token=t.address AND x.block<=$1 LIMIT 1');expect(query).not.toContain('DISTINCT');
    await rawCandidates(db,10n,[],null,true);
    expect(statements[1]!.sql).toContain('x.coin=t.address AND x.block<=$1 LIMIT 1');
  });
  it('limits direct queries as well as batch transactions with parallel workers disabled',async()=>{
    const {db,statements}=fixture();await retentionDb(db).sql.query('SELECT 1');
    expect(statements.map(s=>s.sql)).toEqual(expect.arrayContaining(["SET LOCAL statement_timeout='1s'","SET LOCAL lock_timeout='1s'",'SET LOCAL max_parallel_workers_per_gather=0','SELECT 1']));
  });
  it('shortens every statement to the remaining rule deadline and rolls back on expiry',async()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(1_000);
    try {
      let deadline=10_000;
      const {db,statements,transactions}=fixture();
      const bounded=retentionDb(db,()=>deadline);
      await expect(bounded.tx(async tx=>{
        await tx.sql.query('SELECT 1');deadline=2_000;
        await tx.sql.query('SELECT 2');deadline=1_000;
        await tx.sql.query('SELECT 3');
      })).rejects.toMatchObject({code:'57014'});
      expect(statements.map(s=>s.sql)).toContain("SET LOCAL statement_timeout='1000ms'");
      expect(statements.map(s=>s.sql)).not.toContain('SELECT 3');
      expect(transactions).toEqual(['rollback']);
    } finally {clock.mockRestore();}
  });
  it('skips dry-run estimates without reading large relations',async()=>{
    const {db,statements}=fixture();const result=await runRetention(db,{...options,dryRun:true,settleHours:24,rawDays:7});
    expect(result.tables).toEqual(expect.arrayContaining([expect.objectContaining({table:'token_transfers',rows:0,estimatedBytes:0,estimateSkipped:true}),expect.objectContaining({table:'receipt_publications',estimateSkipped:true})]));
    expect(statements.every(s=>s.sql.startsWith('SET LOCAL') || s.sql.includes('FROM chain_blocks') || s.sql.includes('FROM pg_inherits') || s.sql.includes('FROM raw_history_seals'))).toBe(true);
  });
});

it('allows the raw aggregate timeout while preserving the normal rule limit and shrinking at the deadline',async()=>{
  const clock=vi.spyOn(Date,'now').mockReturnValue(1_000);
  try {
    const {db,statements}=fixture();let ceiling=5_000,deadline=10_000;
    const bounded=retentionDb(db,()=>deadline,()=>ceiling);
    await bounded.sql.query('SELECT 1');ceiling=1_000;
    await bounded.sql.query('SELECT 2');ceiling=5_000;deadline=1_250;
    await bounded.sql.query('SELECT 3');
    expect(statements.map(s=>s.sql)).toEqual(expect.arrayContaining([
      "SET LOCAL statement_timeout='5000ms'","SET LOCAL statement_timeout='1000ms'","SET LOCAL statement_timeout='250ms'"]));
  } finally {clock.mockRestore();}
});
