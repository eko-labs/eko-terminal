import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts, referrals } from '../src/db/schema.js';
import { PointsService } from '../src/points/service.js';
import { parsePointsRates } from '../src/points/config.js';
import { seedReadFixture } from './read-fixture.js';
import { createDemoToken } from '../src/http/v1/demo.js';

const origin='https://app.eko.example',placeholder='fixture-points-placeholder'.repeat(2);
const at='2026-10-14T12:00:00Z',nextDay='2026-10-15T12:00:00Z',now=()=>Date.parse(nextDay);
const rates={guarded_volume:{pointsPerUnit:2,dailyCapPoints:100},shared_journal:{pointsPerUnit:3,dailyCapPoints:10},
  opened_scan:{pointsPerUnit:5,dailyCapPoints:20},ghost_tip:{pointsPerUnit:7,dailyCapPoints:20}};
let built:Awaited<ReturnType<typeof buildApp>>,dir:string,points:PointsService;
beforeAll(async()=>{
  dir=await mkdtemp(join(tmpdir(),'eko-points-'));const tombstone=join(dir,'destruction.log');
  await writeFile(tombstone,'eko-journal-destruction-v1\n',{mode:0o600});
  built=await buildApp(loadConfig({NODE_ENV:'test',PGLITE_DIR:':memory:',LEGACY_API:'false',RUN_WORKER:'false',
    PUBLIC_ORIGIN:origin,SESSION_SECRET:placeholder,DEMO_SECRET:placeholder,HARNESS_KEY_PEPPER:placeholder,
    POINTS_ACTIVE_FROM:'2000-01-01T00:00:00Z',POINTS_RATES:JSON.stringify(rates),
    JOURNAL_KEK:randomBytes(32).toString('hex'),JOURNAL_KEK_ID:'fixture-kek',JOURNAL_TOMBSTONE_PATH:tombstone}),{startBackground:false});
  points=new PointsService(built.ctx.dbh.chain,rates,'2026-10-13T13:00:00Z',now);
});
afterAll(async()=>{await built?.close();await rm(dir,{recursive:true,force:true});});
async function owner(kind:'wallet'|'guest'='wallet') {
  const [a]=await built.ctx.dbh.db.insert(accounts).values({kind}).returning();
  const token=await built.ctx.auth.createSession(a!.id);
  return {id:a!.id,cookie:`eko_sid=${encodeURIComponent(built.app.signCookie(token))}`};
}
const rows=async(accountId:string)=>(await built.ctx.dbh.chain.sql.query<{id:string;source_id:string;points:number;reversal_of:string|null}>('SELECT * FROM points_ledger WHERE account_id=$1 ORDER BY created_at,id',[accountId])).rows;
const volume=(accountId:string,sourceId:string)=>({accountId,sourceId,occurredAt:at,volumeUsd:10,confirmed:true,guarded:true,roundTrip:false,crewWallet:false});

describe('122 points: offline migrated fixtures, no RPC or redemption',()=>{
  it('defaults to disabled rates, requires T and rejects unsupported economics',async()=>{
    const a=await owner();
    for(const service of [new PointsService(built.ctx.dbh.chain,{},undefined,now),new PointsService(built.ctx.dbh.chain,rates,undefined,now),points]) {
      await service.guardedVolume({...volume(a.id,'before-t'),occurredAt:'2026-10-12T00:00:00Z'});
    }
    await new PointsService(built.ctx.dbh.chain,{},'2000-01-01T00:00:00Z',now).guardedVolume(volume(a.id,'disabled'));
    expect(await rows(a.id)).toEqual([]);
    expect(()=>parsePointsRates('{"bounty":{"pointsPerUnit":1,"dailyCapPoints":1}}')).toThrow();
    expect(()=>parsePointsRates('{"guarded_volume":{"pointsPerUnit":1}}')).toThrow();
    expect(()=>parsePointsRates('{"ghost_tip":{"pointsPerUnit":-1,"dailyCapPoints":1}}')).toThrow();
    expect(loadConfig({POINTS_RATES:'{}'}).POINTS_RATES).toEqual({});
    expect((await built.app.inject({method:'POST',url:'/v1/points/redeem',payload:{points:1}})).statusCode).toBe(404);
  });
  it('excludes round trips, crews, missing classifications, unguarded/unconfirmed and guests',async()=>{
    const a=await owner(),g=await owner('guest');
    for(const patch of [{roundTrip:true},{crewWallet:true},{roundTrip:null},{crewWallet:null},{guarded:false},{confirmed:false}])
      expect(await points.guardedVolume({...volume(a.id,`excluded-${JSON.stringify(patch)}`),...patch})).toBeUndefined();
    await points.guardedVolume(volume(g.id,'guest-volume'));
    expect(await rows(a.id)).toEqual([]);expect(await rows(g.id)).toEqual([]);
  });
  it('deduplicates concurrent sources across service instances and caps concurrent daily credits',async()=>{
    const a=await owner(),b=await owner(),other=new PointsService(built.ctx.dbh.chain,rates,'2026-10-13T13:00:00Z',now);
    await Promise.all(Array.from({length:10},(_,i)=>(i%2?points:other).guardedVolume(volume(a.id,'duplicate-fill'))));
    expect(await rows(a.id)).toHaveLength(1);
    await other.guardedVolume(volume(b.id,'duplicate-fill'));expect(await rows(b.id)).toEqual([]);
    await Promise.all(Array.from({length:20},(_,i)=>points.guardedVolume(volume(a.id,`fill-${i}`))));
    expect((await rows(a.id)).reduce((n,r)=>n+r.points,0)).toBe(100);
    await points.guardedVolume({...volume(a.id,'next-day'),occurredAt:nextDay});
    expect((await rows(a.id)).reduce((n,r)=>n+r.points,0)).toBe(120);
  });
  it('requires confirmed Ghost tips and deduplicates them',async()=>{
    const a=await owner(),event={accountId:a.id,sourceId:'sample-tip',occurredAt:at,confirmed:false};
    await points.confirmedGhostTip(event);expect(await rows(a.id)).toEqual([]);
    await Promise.all(Array.from({length:4},()=>points.confirmedGhostTip({...event,confirmed:true})));
    expect((await rows(a.id)).map(r=>r.points)).toEqual([7]);
  });
  it('appends exactly one full reversal, retains the credit and does not restore the daily cap',async()=>{
    const a=await owner();await points.guardedVolume({...volume(a.id,'full-cap'),volumeUsd:100});
    const original=(await rows(a.id))[0];
    await Promise.all(['correction-a','correction-b'].map(source=>points.reverse(original.id,source,at)));
    const entries=await rows(a.id);expect(entries).toHaveLength(2);
    expect(entries.find(r=>r.id===original.id)).toEqual(original);
    expect(entries.reduce((n,r)=>n+r.points,0)).toBe(0);
    await points.guardedVolume(volume(a.id,'after-reversal'));expect(await rows(a.id)).toHaveLength(2);
    const b=await owner();await points.guardedVolume(volume(b.id,'other-credit'));
    const originalCorrection=entries.find(r=>r.reversal_of)?.source_id;
    await points.reverse((await rows(b.id))[0].id,originalCorrection!,at);
    expect(await rows(b.id)).toHaveLength(1);
    for(const command of ['UPDATE points_ledger SET points=1 WHERE id=$1','DELETE FROM points_ledger WHERE id=$1'])
      await expect(built.ctx.dbh.chain.sql.query(command,[original.id])).rejects.toThrow(/append-only/);
    await expect(built.ctx.dbh.chain.sql.query('TRUNCATE points_ledger')).rejects.toThrow(/append-only/);
    await expect(built.ctx.dbh.chain.sql.query(`INSERT INTO points_ledger(account_id,category,source_id,points,occurred_at,earning_day,reversal_of)
      VALUES($1,'guarded_volume','invalid-reversal',-1,$2,'2026-10-14',$3)`,[a.id,at,original.id])).rejects.toThrow(/negate/);
  });
  it('credits shared journal entries atomically without storing their payload in the ledger',async()=>{
    const a=await owner();const agent=await built.ctx.harness.create(a.id,{name:'Sample points agent',kind:'other',preset:'balanced'},10);
    await built.ctx.journal.setConsent(a.id,true);
    await built.ctx.journal.append(a.id,agent.id,{kind:'note',payload:{text:'private-fixture'},share:false});
    expect(await rows(a.id)).toEqual([]);
    const entry=await built.ctx.journal.append(a.id,agent.id,{kind:'note',payload:{text:'private-fixture'},share:true});
    expect((await rows(a.id)).map(r=>({source:r.source_id,points:r.points}))).toEqual([{source:entry.id,points:3}]);
    await built.ctx.dbh.chain.tx(tx=>built.ctx.points.sharedJournal(tx,{accountId:a.id,sourceId:entry.id,occurredAt:entry.ts}));
    expect(await rows(a.id)).toHaveLength(1);
    await expect(built.ctx.dbh.chain.tx(async tx=>{
      await built.ctx.points.sharedJournal(tx,{accountId:a.id,sourceId:'rolled-back-share',occurredAt:entry.ts});throw new Error('fixture rollback');
    })).rejects.toThrow('fixture rollback');
    expect(await rows(a.id)).toHaveLength(1);
    expect(JSON.stringify(await rows(a.id))).not.toContain('private-fixture');
  });
  it('attributes persisted scans once and credits only another verified wallet opening a ready card',async()=>{
    const a=await owner(),b=await owner(),g=await owner('guest');
    const card=await seedReadFixture(built.ctx.dbh.chain,Date.now());
    const scan=await built.app.inject({url:`/v1/scan?q=${card.identity.address}`,headers:{cookie:a.cookie}});
    const id=scan.json().id;
    await built.app.inject({url:`/v1/scan?q=${card.identity.address}`,headers:{cookie:b.cookie}});
    for(const cookie of [a.cookie,g.cookie,'',`${b.cookie}; eko_demo=${createDemoToken([],placeholder)}`])
      expect((await built.app.inject({url:`/v1/scan/${id}`,headers:{cookie}})).statusCode).toBe(200);
    expect(await rows(a.id)).toEqual([]);
    await Promise.all(Array.from({length:4},()=>built.app.inject({url:`/v1/scan/${id}`,headers:{cookie:b.cookie}})));
    expect((await rows(a.id)).map(r=>r.points)).toEqual([5]);expect(await rows(b.id)).toEqual([]);
    const pending=(await built.app.inject({url:'/v1/scan?q=0x0000000000000000000000000000000000009999',headers:{cookie:a.cookie}})).json();
    await built.app.inject({url:`/v1/scan/${pending.id}`,headers:{cookie:b.cookie}});expect(await rows(a.id)).toHaveLength(1);
  });
  it('enforces self-referral in storage and persists referral codes/counts across requests without bonuses',async()=>{
    const a=await owner(),b=await owner(),c=await owner();
    await expect(built.ctx.dbh.db.insert(referrals).values({referrerAccountId:a.id,referredAccountId:a.id})).rejects.toThrow();
    await Promise.all([b,c].map(r=>built.ctx.dbh.db.insert(referrals).values({referrerAccountId:a.id,referredAccountId:r.id}).onConflictDoNothing()));
    const stats=(await built.app.inject({url:'/v1/referrals',headers:{cookie:a.cookie}})).json();
    expect(stats).toMatchObject({referred:2,qualified:0,bonusMinutes:0});
    const me=(await built.app.inject({url:'/v1/me',headers:{cookie:a.cookie}})).json();
    expect(stats.code).toBe(me.referralCode);
    expect((await built.app.inject({url:'/v1/referrals',headers:{cookie:a.cookie}})).json()).toEqual(stats);
    expect(await rows(a.id)).toEqual([]);
  });
});
