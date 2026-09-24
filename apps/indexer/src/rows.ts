import { binary, chainTables, hex, applyBalanceDeltas, rebuildBars, refreshBars, type BusMessage, type ChainDb } from '@eko/db';
import type { Address, Hex } from 'viem';
type Row = Record<string, unknown>;
/** Where a flush spends its time, in milliseconds (callers accumulate across batches). */
export interface FlushTimings { insertMs: number; updateMs: number; balancesMs: number; barsMs: number; notifyMs: number }
export const emptyFlushTimings = (): FlushTimings => ({ insertMs: 0, updateMs: 0, balancesMs: 0, barsMs: 0, notifyMs: 0 });
const eventKey = (r: Row) => `${hex(r.tx_hash as Uint8Array)}:${Number(r.log_index)}:${BigInt(String(r.block))}`;
const firstSeen = (rows: Row[]) => { const seen = new Set<string>(); return rows.filter(r => { const key = hex(r.address as Uint8Array); if (seen.has(key)) return false; seen.add(key); return true; }); };
/** A block (or bounded backfill chunk) stages rows, then issues one multi-row insert per table. */
export class BlockRows {
  private rows = new Map<typeof chainTables[number], Row[]>();
  private launches: { token: Address; curve: Address; deployer: Address; block: bigint }[] = [];
  private graduations: { token: Address; pool: Hex; block: bigint }[] = [];
  graduation(token: Address, pool: Hex, block: bigint) { this.graduations.push({ token, pool, block }); }
  add(table: typeof chainTables[number], row: Row) {
    const rows = this.rows.get(table) ?? []; rows.push(row); this.rows.set(table, rows);
  }
  launch(token: Address, curve: Address, deployer: Address, block: bigint) { this.launches.push({ token, curve, deployer, block }); }
  merge(other: BlockRows) {
    for (const [table, rows] of other.rows) for (const row of rows) this.add(table, row);
    this.launches.push(...other.launches);
    this.graduations.push(...other.graduations);
  }
  get(table: typeof chainTables[number]): readonly Row[] {return this.rows.get(table)??[];}
  /** Lock the whole raw-write batch before any source trigger can dirty a projection. */
  async lockReadCoins(db:ChainDb,extra:Uint8Array[]=[]) {
    const coins:Uint8Array[]=[...extra];
    for(const [table,rows] of this.rows)for(const row of rows) {
      const fields=table==='tokens' ? ['address'] : table==='pools' ? ['currency0','currency1'] : ['coin','token'];
      for(const field of fields)if(row[field] instanceof Uint8Array)coins.push(row[field] as Uint8Array);
    }
    for(const row of [...this.launches,...this.graduations])coins.push(binary(row.token));
    await db.lockReadCoins(coins);
  }
  /**
   * `notify: false` writes the rows without announcing them: for rows of long-settled blocks (stored raw events turned
   * into swaps). Every swap notice makes the API look the swap up as a new trade.
   */
  async flush(db: ChainDb, timings?: FlushTimings, options: { notify?: boolean } = {}) {
    await this.lockReadCoins(db);
    const notifications: BusMessage[] = [];
    let insertedTransfers: Record<string, unknown>[] = [];
    let mark = performance.now();
    const spent = (phase: keyof FlushTimings) => { const now = performance.now(); if (timings) timings[phase] += now - mark; mark = now; };
    for (const table of chainTables) {
      // A wallet row is first-seen only: ON CONFLICT DO NOTHING keeps the first staged row, so later duplicates are dropped before the insert.
      const staged = table === 'wallets' ? firstSeen(this.rows.get(table) ?? []) : this.rows.get(table) ?? [];
      const rows = table === 'eth_usd_reference_sources' ? [] : await db.insertMany(table, staged);
      spent('insertMs');
      // A row this flush inserted already holds its staged values, so the fill-in updates below would match nothing
      // for it; they only visit rows that were stored before (replays). A key staged twice keeps the old path.
      const inserted = new Set<string>();
      if (table === 'pons_events' || table === 'swaps' || table === 'liquidity_events') {
        const counts = new Map<string, number>();
        for (const r of staged) { const key = eventKey(r); counts.set(key, (counts.get(key) ?? 0) + 1); }
        for (const r of rows) { const key = eventKey(r); if (counts.get(key) === 1) inserted.add(key); }
      }
      if (table === 'token_transfers') insertedTransfers = rows;
      if (table === 'eth_usd_reference_sources') {
        // Canonical replay may select a different source at the same pricing block.
        const sources = [...new Map((this.rows.get(table) ?? []).map(r => [r.block, r])).values()];
        for (let offset = 0; offset < sources.length; offset += 500) {
          const params: unknown[] = [];
          const values = sources.slice(offset, offset + 500).map(r => {
            const i = params.length; params.push(r.block, r.pool_id, r.venue, r.fee);
            return `($${i+1}::bigint,$${i+2}::bytea,$${i+3}::text,$${i+4}::integer)`;
          });
          await db.sql.query(`INSERT INTO eth_usd_reference_sources(block,pool_id,venue,fee) VALUES ${values.join(',')}
            ON CONFLICT(block) DO UPDATE SET pool_id=excluded.pool_id,venue=excluded.venue,fee=excluded.fee
            WHERE (eth_usd_reference_sources.pool_id,eth_usd_reference_sources.venue,eth_usd_reference_sources.fee)
              IS DISTINCT FROM (excluded.pool_id,excluded.venue,excluded.fee)`, params);
        }
      }
      if (table === 'pons_events') {
        // Re-decoding canonical history fills fields omitted by older decoders without
        // replacing existing evidence or producing duplicate insert notifications.
        const events=(this.rows.get(table) ?? []).filter(r=>!inserted.has(eventKey(r)));
        for(let offset=0;offset<events.length;offset+=500) {
          const params:unknown[]=[];
          const values=events.slice(offset,offset+500).map(r=>{
            const i=params.length;params.push(r.tx_hash,r.log_index,r.block,r.token,r.emitter,r.kind,r.data);
            return `($${i+1}::bytea,$${i+2}::integer,$${i+3}::bigint,$${i+4}::bytea,$${i+5}::bytea,$${i+6}::text,$${i+7}::jsonb)`;
          });
          await db.sql.query(`UPDATE pons_events e SET data=p.data || e.data FROM (VALUES ${values}) AS p(tx_hash,log_index,block,token,emitter,kind,data)
            WHERE e.tx_hash=p.tx_hash AND e.log_index=p.log_index AND e.block=p.block AND e.token=p.token AND e.emitter=p.emitter AND e.kind=p.kind
            AND ((e.kind='launch' AND NOT e.data ? 'graduationThreshold' AND p.data ? 'graduationThreshold')
              OR (e.kind='trade' AND NOT e.data ? 'taxEth' AND p.data ? 'taxEth'))`,params);
        }
      }
      if (table === 'swaps') {
        const id = (r: Row) => `${(r.ts instanceof Date ? r.ts : new Date(r.ts as string)).toISOString()}:${hex(r.tx_hash as Uint8Array)}:${r.log_index}`;
        const fresh = new Set(rows.map(id));
        const replayed = (this.rows.get('swaps') ?? []).filter(r => !fresh.has(id(r)));
        // Re-indexing recomputes derived USD, including clearing values whose reference was unverified.
        // Raw amounts, senders and identity remain unchanged; candles are refreshed below.
        for (let offset = 0; offset < replayed.length; offset += 500) {
          const params: unknown[] = [];
          const values = replayed.slice(offset, offset + 500).map(r => {
            const i = params.length; params.push(r.ts, r.tx_hash, r.log_index, r.usd, r.priced_block, r.price_quote);
            return `($${i + 1}::timestamptz,$${i + 2}::bytea,$${i + 3}::integer,$${i + 4}::double precision,$${i + 5}::bigint,$${i + 6}::double precision)`;
          });
          await db.sql.query(`UPDATE swaps s SET price_quote=coalesce(s.price_quote,p.price_quote),pricing_pending=s.pricing_pending AND p.price_quote IS NULL,
            usd=p.usd,priced_block=p.priced_block
            FROM (VALUES ${values.join(',')}) AS p(ts,tx_hash,log_index,usd,priced_block,price_quote) WHERE s.ts=p.ts AND s.tx_hash=p.tx_hash AND s.log_index=p.log_index AND (s.usd IS DISTINCT FROM p.usd OR s.priced_block IS DISTINCT FROM p.priced_block OR s.pricing_pending)`, params);
        }
      }
      // Canonical re-decoding can fill missing holder actors; never overwrite an attributed row.
      if (table === 'swaps' || table === 'liquidity_events') {
        const field=table==='swaps' ? 'trader' : 'actor';
        const resolved=(this.rows.get(table) ?? []).filter(r=>r[field]!=null && !r.senders_pending && !inserted.has(eventKey(r)));
        for(let offset=0;offset<resolved.length;offset+=250) {
          const params:unknown[]=[];
          const values=resolved.slice(offset,offset+250).map(r=>{const i=params.length;params.push(r.tx_hash,r.log_index,r.block,r[field],r.tx_from,r.tx_to);return `($${i+1}::bytea,$${i+2}::integer,$${i+3}::bigint,$${i+4}::bytea,$${i+5}::bytea,$${i+6}::bytea)`;});
          await db.sql.query(`UPDATE ${table} e SET ${field}=p.actor,tx_from=p.tx_from,tx_to=p.tx_to,senders_pending=false
            FROM (VALUES ${values.join(',')}) AS p(tx_hash,log_index,block,actor,tx_from,tx_to)
            WHERE e.tx_hash=p.tx_hash AND e.log_index=p.log_index AND e.block=p.block AND (e.${field} IS NULL OR e.senders_pending)`,params);
        }
      }
      spent('updateMs');
      for (const row of rows) {
        const asHex = (key: string) => hex(row[key] as Uint8Array);
        if (table === 'chain_blocks') notifications.push({ topic:'chain_block',ids:{ n:String(row.number) } });
        if (table === 'pools') notifications.push({ topic: 'pair_created', ids: { id: asHex('id') } });
        if (table === 'swaps' || table === 'liquidity_events') notifications.push({ topic: table === 'swaps' ? 'swap' : 'liquidity', ids: { txHash: asHex('tx_hash'), logIndex: Number(row.log_index) } });
        if (table === 'pons_exemptions') notifications.push({ topic: 'pons_exempt', ids: { token: asHex('token'), wallet: asHex('wallet') } });
      }
    }
    // Historical launches enrich tokens first discovered by live pool reads; replayed launches do nothing.
    for (let offset = 0; offset < this.launches.length; offset += 500) {
      const params: unknown[] = [];
      const values = this.launches.slice(offset, offset + 500).map(l => {
        const i = params.length; params.push(binary(l.token), binary(l.curve), binary(l.deployer), l.block.toString());
        return `($${i + 1}::bytea,$${i + 2}::bytea,$${i + 3}::bytea,$${i + 4}::bigint)`;
      });
      await db.sql.query(`UPDATE tokens t SET launchpad='pons',curve=l.curve,deployer=l.deployer,first_block=LEAST(t.first_block,l.block),block=LEAST(t.block,l.block) FROM (VALUES ${values.join(',')}) AS l(address,curve,deployer,block) WHERE t.address=l.address AND t.curve IS NULL`, params);
    }
    for(const table of ['tokens','pools'] as const) {
      const unique=[...new Map((this.rows.get(table)??[]).map(r=>[hex(r[table==='tokens'?'address':'id'] as Uint8Array),r])).values()];
      for(let offset=0;offset<unique.length;offset+=250){
        const params:unknown[]=[];
        const fields=table==='tokens'?['address','total_supply','supply_block','symbol','name','decimals']:['id','created_block','currency0','currency1','fee','tick_spacing','hooks','creation_verified'];
        const types=table==='tokens'?['bytea','numeric','bigint','text','text','integer']:['bytea','bigint','bytea','bytea','integer','integer','bytea','boolean'];
        const values=unique.slice(offset,offset+250).map(r=>`(${fields.map((f,i)=>{params.push(r[f]);return `$${params.length}::${types[i]}`;}).join(',')})`);
        const supply='p.total_supply IS NOT NULL AND (t.total_supply IS NULL OR t.supply_block<=p.supply_block)';
        await db.sql.query(table==='tokens'?`UPDATE tokens t SET symbol=coalesce(t.symbol,p.symbol),name=coalesce(t.name,p.name),decimals=coalesce(t.decimals,p.decimals),
          total_supply=CASE WHEN ${supply} THEN p.total_supply ELSE t.total_supply END,supply_block=CASE WHEN ${supply} THEN p.supply_block ELSE t.supply_block END
          FROM (VALUES ${values}) AS p(${fields}) WHERE t.address=p.address`:
          `UPDATE pools t SET created_block=p.created_block,block=p.created_block,creation_verified=t.creation_verified OR p.creation_verified,currency0=p.currency0,currency1=p.currency1,fee=p.fee,tick_spacing=p.tick_spacing,hooks=p.hooks FROM (VALUES ${values}) AS p(${fields}) WHERE t.id=p.id AND ((p.creation_verified AND (NOT t.creation_verified OR t.created_block>=p.created_block)) OR (NOT t.creation_verified AND t.created_block>=p.created_block))`,params);
      }
    }
    const changed = new Set<Hex>();
    for (const g of this.graduations) {
      const result = await db.sql.query(`UPDATE tokens SET launchpad='pons',graduated_pool=$2,graduated_block=$3
        WHERE address=$1 AND (graduated_block IS NULL OR graduated_block > $3) RETURNING address`, [binary(g.token),binary(g.pool),g.block.toString()]);
      if (result.rows.length) changed.add(g.token);
    }
    spent('updateMs');
    // Only rows this flush actually inserted move balances, so replaying a block never double-counts.
    if (insertedTransfers.length) await applyBalanceDeltas(db, insertedTransfers);
    spent('balancesMs');
    const swaps = this.rows.get('swaps') ?? [];
    if (swaps.length || changed.size) {
      for (const coin of changed) {
        const last = (await db.sql.query<{ n: string }>('SELECT coalesce(max(block),0) AS n FROM swaps WHERE coin=$1', [binary(coin)])).rows[0].n;
        await rebuildBars(db, 0n, BigInt(last), coin);
      }
      if (swaps.length) {
        await refreshBars(db, swaps.map(r => ({ coin: r.coin as Uint8Array, minute: new Date(Math.floor(new Date(r.ts as Date).getTime() / 60000) * 60000) })));
      }
    }
    spent('barsMs');
    if (options.notify !== false) await db.notifyMany(notifications);
    spent('notifyMs');
  }
}
