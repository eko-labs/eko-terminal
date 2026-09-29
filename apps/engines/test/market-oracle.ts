import type { ChainDb } from '@eko/db';
import { rowHex } from '../src/aggregates.js';
/** SQL is an oracle only for fixtures whose ranks cannot depend on float summation order. */
export const rankedSql=`SELECT coin FROM swaps WHERE block<=$1 AND ts>to_timestamp($2) AND usd>0 AND usd<'Infinity'::double precision GROUP BY coin ORDER BY sum(usd) DESC,coin`;
export async function sqlRanks(db:ChainDb,block:number,sec:number){const rows=(await db.sql.query<{coin:Uint8Array}>(rankedSql,[block,sec-3600])).rows;return new Map(rows.map((row,i)=>[rowHex(row.coin),i+1]));}
