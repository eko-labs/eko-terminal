import type { CoinCard, CoinCardV2, PairRow, RadarRow } from '@eko/shared';
type Identity = { stage: 'curve' | 'graduated' | 'unknown' } & Pick<CoinCard['identity'], 'address' | 'name' | 'symbol' | 'launchpad'>;
const identities = new Map<string, Identity>();
export function rememberCoinIdentity(identity: Identity | PairRow | RadarRow | CoinCardV2['identity']) {
  const key = identity.address.toLowerCase(); identities.delete(key);
  identities.set(key, { address: identity.address, name: identity.name, symbol: identity.symbol, launchpad: identity.launchpad, stage: identity.stage });
  if (identities.size > 1000) identities.delete(identities.keys().next().value!);
}
export const knownCoinIdentity = (address: string) => identities.get(address.toLowerCase());
