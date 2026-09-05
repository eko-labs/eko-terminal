import { expect, it, vi } from 'vitest';
import { ChainDb, type SqlClient } from '../src/client.js';
import { refreshBars } from '../src/market.js';

it('locks the entire coin set before bar locks or any delete, including batches larger than one SQL chunk',async()=>{
 const statements:{text:string;params?:unknown[]}[]=[];
 const sql:SqlClient={query:async(text,params)=>{statements.push({text,params});return {rows:[{available:true}] as never[]};}};
 const db=new ChainDb(sql,fn=>fn(sql));db.ensurePartitions=vi.fn(async()=>{});
 const touched=Array.from({length:251},(_,i)=>({coin:Buffer.from(i.toString(16).padStart(40,'0'),'hex'),minute:new Date('2026-10-01T00:00:00Z')})).reverse();
 await db.tx(tx=>{tx.ensurePartitions=db.ensurePartitions;return refreshBars(tx,touched);});
 const lock=statements.findIndex(s=>s.text==='SELECT read_lock_coins($1::bytea[])');
 expect(lock).toBeGreaterThanOrEqual(0);expect(statements[lock].params?.[0]).toHaveLength(251);
 expect(statements.findIndex(s=>s.text.startsWith('INSERT INTO bar_write_locks'))).toBeGreaterThan(lock);
 expect(statements.filter(s=>s.text.startsWith('DELETE FROM bars_1m'))).toHaveLength(2);
 expect(statements.filter(s=>s.text==='SELECT read_lock_coins($1::bytea[])')).toHaveLength(1);
});
