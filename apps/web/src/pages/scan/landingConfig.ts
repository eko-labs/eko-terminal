import { PublicConfigSchema } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
export async function examples(signal: AbortSignal) {
  return (await fetchParsed('/config', PublicConfigSchema, { signal })).exampleScans;
}
