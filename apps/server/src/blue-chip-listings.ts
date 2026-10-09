import { z } from 'zod';
import { binary, type ChainDb } from '@eko/db';
import { AddressSchema } from '@eko/shared';
const DAY_MS = 86_400_000;
const URL = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
const listSchema = z.array(z.object({ id:z.string().min(1), platforms:z.record(z.string(),z.string().nullable()) }));
/** Sole Blue chip outbound request. Validation and replacement are atomic, so failure retains the last successful list. */
export class BlueChipListingWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<boolean>;
  private stopped = true;
  private nextSyncAt = 0;
  constructor(readonly db: ChainDb, readonly enabled: boolean, readonly fetcher: typeof fetch = fetch,
    readonly now: () => number = Date.now, readonly log: (success:boolean)=>void = ()=>{}) {}
  sync(): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    if (this.running) return this.running;
    this.running = this.pass().finally(()=>{this.running=undefined;});
    return this.running;
  }
  private async pass() {
    try {
      const last = (await this.db.sql.query<{last_success:Date}>("SELECT last_success FROM coin_listing_sync WHERE source='coingecko'")).rows[0];
      if (last && this.now()-new Date(last.last_success).getTime()<DAY_MS) { this.nextSyncAt=new Date(last.last_success).getTime()+DAY_MS;return true; }
      const response = await this.fetcher(URL,{signal:AbortSignal.timeout(30_000),redirect:'error'});
      if (!response.ok) throw new Error('listing_fetch_failed');
      const list = listSchema.parse(await response.json());
      if (!list.length) throw new Error('listing_empty_response');
      const addresses = new Map<string,string>();
      for (const item of list) {
        const raw = item.platforms.robinhood;
        if (raw == null || raw === '') continue;
        const address = AddressSchema.parse(raw).toLowerCase();
        addresses.set(address,item.id);
      }
      const at = new Date(this.now());
      await this.db.tx(async tx=>{
        await tx.sql.query("UPDATE coin_listings SET active=false WHERE source='coingecko' AND active");
        const entries = [...addresses];
        for (let offset=0;offset<entries.length;offset+=500) {
          const params:unknown[]=[];
          const values = entries.slice(offset,offset+500).map(([coin,id])=>{
            params.push(binary(coin),id,at);const n=params.length;
            return `($${n-2},'coingecko',$${n-1},$${n},$${n},true)`;
          });
          await tx.sql.query(`INSERT INTO coin_listings(coin,source,external_id,first_seen,last_seen,active) VALUES ${values.join(',')}
            ON CONFLICT(coin,source) DO UPDATE SET external_id=excluded.external_id,last_seen=excluded.last_seen,active=true`,params);
        }
        await tx.sql.query("INSERT INTO coin_listing_sync VALUES('coingecko',$1) ON CONFLICT(source) DO UPDATE SET last_success=excluded.last_success",[at]);
      });
      this.nextSyncAt=at.getTime()+DAY_MS;this.log(true);return true;
    } catch { this.nextSyncAt=this.now()+DAY_MS;this.log(false);return false; }
  }
  start() {
    if (!this.enabled || !this.stopped) return;
    this.stopped=false;
    const run=async()=>{
      await this.sync();
      if (!this.stopped) { this.timer=setTimeout(()=>{void run();},Math.max(1,this.nextSyncAt-this.now()));this.timer.unref(); }
    };
    void run();
  }
  async stop() { this.stopped=true;clearTimeout(this.timer);await this.running; }
}
