import { z } from 'zod';
import { RadarRowSchema, type RadarRow } from '@eko/shared';
import { fetchParsed } from './api';

/**
 * One coin's radar row (price moves, market cap, liquidity, volume, score) for its page. Asks the server for that row
 * alone (GET /radar/:address answers `{ row }`, a few hundred bytes) instead of the whole 100-row list; where that route
 * is not served (offline demo data, an older server) it falls back to the list and picks the coin out. Null when the
 * coin has no row.
 */
const One = z.object({ row: RadarRowSchema.nullable() });
const List = z.object({ rows: z.array(RadarRowSchema) });
export async function fetchCoinRow(address: string, signal?: AbortSignal): Promise<RadarRow | null> {
  const opts = signal ? { signal } : {};
  try { return (await fetchParsed(`/radar/${encodeURIComponent(address)}`, One, opts)).row; }
  catch (e) { if ((e as Error).name === 'AbortError') throw e; }
  const r = await fetchParsed('/radar', List, opts);
  return r.rows.find(c => c.address.toLowerCase() === address.toLowerCase()) ?? null;
}
