import { openDb as openRealDb, type ChainDb } from '../../src/client.js';

/** Historical fixtures explicitly install their source days; production provisioning uses wall-clock retention. */
export async function provisionHistory(db:ChainDb,date:Date,daysAhead=3) {
  const day=Date.parse(date.toISOString().slice(0,10));
  await db.tx(async tx=>{
    await tx.sql.query("SET LOCAL lock_timeout='2s'");
    const bounds=(await tx.sql.query<{parent:string;bound:string}>(`SELECT p.relname AS parent,pg_get_expr(c.relpartbound,c.oid) AS bound
      FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent
      WHERE i.inhparent IN ('swaps'::regclass,'token_transfers'::regclass)`)).rows;
    for(const table of ['swaps','token_transfers'])for(let offset=-(table==='swaps'?7:3);offset<=daysAhead;offset++) {
      const start=day+offset*86400000,end=start+86400000;
      if(bounds.some(b=>{const r=[...b.bound.matchAll(/'([^']+)'/g)].map(m=>Date.parse(m[1]!));return b.parent===table && r[0]!<=start && r[1]!>=end;}))continue;
      const suffix=`d${new Date(start).toISOString().slice(0,10).replaceAll('-','_')}`;
      await tx.sql.query(`CREATE TABLE IF NOT EXISTS ${table}_${suffix} PARTITION OF ${table} FOR VALUES FROM ('${new Date(start).toISOString()}') TO ('${new Date(end).toISOString()}')`);
    }
  });
}
const decorated=new WeakSet<ChainDb>();
export function withHistoryFixtures(db:ChainDb) {
  if(decorated.has(db))return db;
  decorated.add(db);
  const ensure=db.ensurePartitions.bind(db),days=new Set<string>();
  db.ensurePartitions=async(date,opts={})=>{
    const key=`${date.toISOString().slice(0,10)}:${opts.daysAhead ?? 3}`;
    if(!days.has(key)) {await provisionHistory(db,date,opts.daysAhead);days.add(key);}
    await ensure(date,opts);
  };
  return db;
}
export async function openDb(options:Parameters<typeof openRealDb>[0]={}) {
  return withHistoryFixtures(await openRealDb(options));
}
