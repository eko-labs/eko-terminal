import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { replayFixture } from './replay-fixture.js';

// Startup includes fixture seeding, tsx/PGlite boot and reaching 100 evaluations.
const startupBudgetMs=90000,shutdownBudgetMs=15000;
// Allow database reopen/assertions/cleanup after both independently bounded phases.
const testBudgetMs=startupBudgetMs+shutdownBudgetMs+30000;

describe('replay CLI shutdown',()=>{
 it.each(['SIGINT','SIGTERM'] as const)('drains the current evaluation on %s, prints the summary and closes PGlite',async signal=>{
  const startupAt=performance.now();
  const directory=await mkdtemp(join(tmpdir(),'eko-replay-'));
  try {
    const seed=await replayFixture(60,10,directory);await seed.close();
    const startupRemainingMs=startupBudgetMs-(performance.now()-startupAt);
    expect(startupRemainingMs,'Fixture seeding exhausted the startup budget').toBeGreaterThan(0);
    const child=spawn(process.execPath,['--import','tsx','src/cli.ts'],{
      cwd:process.cwd(),env:{PATH:process.env.PATH,APP_ROLE:'engines',ENGINE_MODE:'replay',PGLITE_DIR:directory,FROM:'1',TO:'10',ENGINE_CONCURRENCY:'4'},stdio:['ignore','pipe','pipe'],
    });
    let output='',errors='',pending='',sent=false,delivered=false,signalAt=0,exitAt=0;
    let timedOut:'startup'|'shutdown'|undefined;
    const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{exitAt=performance.now();resolve({code,signal});});});
    let watchdog=setTimeout(()=>{timedOut='startup';child.kill('SIGKILL');},startupRemainingMs);
    child.stdout.on('data',chunk=>{
      const text=chunk.toString();output+=text;pending+=text;
      let newline:number;
      while((newline=pending.indexOf('\n'))!==-1){
        const line=pending.slice(0,newline);pending=pending.slice(newline+1);
        if(!line || sent || timedOut)continue;
        const row=JSON.parse(line);
        // The time-based progress heartbeat can precede 100 evaluations on a loaded machine.
        // Wait for the evaluation milestone, with handlers already installed, before signaling.
        if(row.event==='engine_progress' && row.evaluations>=100){
          sent=true;clearTimeout(watchdog);signalAt=performance.now();
          watchdog=setTimeout(()=>{timedOut='shutdown';child.kill('SIGKILL');},shutdownBudgetMs);
          delivered=child.kill(signal);
        }
      }
    });
    child.stderr.on('data',chunk=>{errors+=chunk.toString();});
    const result=await closed.finally(()=>clearTimeout(watchdog));
    expect(timedOut,`${timedOut} budget exhausted; stderr: ${errors}`).toBeUndefined();
    expect(sent).toBe(true);expect(delivered).toBe(true);
    // Check wall time too: a delayed parent timer must not hide a slow shutdown.
    expect(exitAt-signalAt).toBeLessThan(shutdownBudgetMs);
    expect(result,errors).toEqual({code:0,signal:null});
    const summary=output.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.event==='replay_interrupted');
    expect(summary,output).toBeDefined();
    const planned=output.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.event==='replay_planned');
    expect(planned).toMatchObject({tasks:600,coins:60,from:1,to:10});
    expect(summary.evaluationsPerSec).toBeGreaterThan(0);expect(summary.rssMb).toBeGreaterThan(0);expect(summary.rpcCalls).toEqual({});expect(summary.timeShare.sourceLoading).toBeGreaterThan(0);expect(summary.timeShare.writeTransaction).toBeGreaterThan(0);
    expect(summary.evaluations).toBeGreaterThanOrEqual(100);expect(summary.evaluations).toBeLessThan(600);
    expect(summary.coinsEvaluated).toBe(60);expect(summary.verdicts).toEqual({clear:0,pending:60,monitor:0,danger:0});expect(summary.playbooks).toEqual({});
    const reopened=await openDb({pgliteDir:directory});
    try {expect(Number((await reopened.sql.query<{n:string}>('SELECT count(*) AS n FROM engine_runs')).rows[0].n)).toBe(summary.evaluations);}
    finally {await reopened.close();}
  } finally {await rm(directory,{recursive:true,force:true});}
 },testBudgetMs);
});

it('exits non-zero for invalid engine configuration', () => {
 const result=spawnSync(process.execPath,['--import','tsx','src/cli.ts'],{cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH,APP_ROLE:'engines',RPC_HTTP_URL:'invalid'},encoding:'utf8'});
 expect(result.status).toBe(1);expect(result.stderr).toContain('Engines halted');
});
