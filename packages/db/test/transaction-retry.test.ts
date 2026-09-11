import { afterEach, expect, it, vi } from 'vitest';
import { ChainDb, TransactionRetryExhaustedError, type SqlClient } from '../src/client.js';

afterEach(()=>vi.useRealTimers());
for(const code of ['40P01','40001'])it(`retries ${code} from a fresh transaction, discarding failed notifications and hooks`,async()=>{
  vi.useFakeTimers();
  const sql:SqlClient={query:async()=>({rows:[]})},events:string[]=[];
  let attempts=0,state=0;
  const db=new ChainDb(sql,async work=>{
    events.push('begin');const result=await work(sql);
    if(++attempts<3){events.push('rollback');throw {code};}
    events.push('commit');return result;
  });
  const publish=vi.spyOn(db.bus,'publish'),committed=vi.fn();
  const result=db.tx(async tx=>{
    expect(state).toBe(0);state++;
    tx.afterRollback(()=>{state=0;});tx.afterCommit(committed);
    await tx.tx(nested=>nested.notify('chain_block',{n:attempts}));
    return 7;
  },{retry:true});
  await vi.runAllTimersAsync();
  expect(await result).toBe(7);expect(events).toEqual(['begin','rollback','begin','rollback','begin','commit']);
  expect(state).toBe(1);expect(committed).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledExactlyOnceWith({topic:'chain_block',ids:{n:2}});
});

it('bounds retries, counts exhaustion once, and allows the next batch to commit',async()=>{
  vi.useFakeTimers();
  const sql:SqlClient={query:async()=>({rows:[]})};let blocked=true,attempts=0;
  const db=new ChainDb(sql,async work=>{attempts++;if(blocked)throw {code:'40P01'};return work(sql);});
  const emit=vi.fn(),stop=db.startTransactionMetrics(emit);
  const failed=expect(db.tx(async()=>1,{retry:true})).rejects.toBeInstanceOf(TransactionRetryExhaustedError);
  await vi.advanceTimersByTimeAsync(1000);await failed;
  expect(attempts).toBe(5);blocked=false;
  expect(await db.tx(async()=>2,{retry:true})).toBe(2);
  await vi.advanceTimersByTimeAsync(59000);
  expect(emit).toHaveBeenLastCalledWith({event:'db_transaction_contention',db_deadlock_retries:4,db_deadlock_skipped:1});
  stop();expect(emit).toHaveBeenLastCalledWith({event:'db_transaction_contention',db_deadlock_retries:0,db_deadlock_skipped:0});
});

it('does not retry unrelated errors, opt-out transactions or post-commit hooks',async()=>{
  const sql:SqlClient={query:async()=>({rows:[]})},transaction=vi.fn(async(work:(sql:SqlClient)=>Promise<unknown>)=>work(sql));
  const db=new ChainDb(sql,transaction as never);
  await expect(db.tx(async()=>{throw {code:'23505'};},{retry:true})).rejects.toEqual({code:'23505'});
  await expect(db.tx(async()=>{throw {code:'40P01'};})).rejects.toEqual({code:'40P01'});
  await expect(db.tx(async tx=>{tx.afterCommit(()=>{throw {code:'40P01'};});},{retry:true})).rejects.toEqual({code:'40P01'});
  expect(transaction).toHaveBeenCalledTimes(3);
});
