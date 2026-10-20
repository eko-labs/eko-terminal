import { binary, candles, readFlows, readMarkers, unavailableFlow, type Timeframe } from '@eko/db';
import type { Address } from '@eko/shared';
import type { ReadStore } from './store.js';
export class CoinsService {
  constructor(readonly store:ReadStore) {}
  card(address:Address) {return this.store.card(address);}
  verdict(address:Address) {return this.store.verdict(address);}
  async candles(address:Address,tf:Timeframe,from:number,to:number) {
    if(tf==='1s' || tf==='15s')return {...await candles(this.store.db,address,tf,from,to,this.store.now()/1000),delayedSec:0};
    // Trades of a coin whose old swaps retention deleted are summarised in history_prunes (its minute bars are kept).
    const [result,history]=await Promise.all([candles(this.store.db,address,tf,from,to,this.store.now()/1000),this.store.db.sql.query<{first:Date|null;last:Date|null}>(`SELECT
      least(min(s.ts),(SELECT first_trade_ts FROM history_prunes WHERE coin=$1)) AS first,greatest(max(s.ts),(SELECT last_trade_ts FROM history_prunes WHERE coin=$1)) AS last
      FROM swaps s WHERE s.coin=$1`,[binary(address)])]);
    const h=history.rows[0];return {...result,firstTradeTs:h.first ? new Date(h.first).getTime()/1000 : null,lastTradeTs:h.last ? new Date(h.last).getTime()/1000 : null,delayedSec:0};
  }
  markers(address:Address,from:number,to:number) {return readMarkers(this.store.db,address,from,to);}
  async flow(address:Address,window:'5m'|'1h'|'24h') {
    const card=await this.card(address);
    return card ? {...((await readFlows(this.store.db,[address],window)).get(address)??unavailableFlow(window,card.freshness.block)),delayedSec:0} : null;
  }
}
