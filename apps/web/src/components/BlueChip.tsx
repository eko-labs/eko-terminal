import type { BlueChip, BlueChipCriteria } from '@eko/shared';
export function BlueChipBadge({value}:{value?:BlueChip}) {
  return value?.member ? <span className="tag" title={value.via.includes('coingecko') ? 'Listing data from CoinGecko' : 'Earned on this chain'}>Blue chip</span> : null;
}
export function BlueChipDetails({value,criteria}:{value?:BlueChip;criteria?:BlueChipCriteria}) {
  if(!value || !criteria)return null;
  return <details className="panel"><summary>Blue chip criteria{value.member ? ' · Member' : ' · Not a member'}</summary><div className="panel-body">
    <p>Membership describes observed facts. It is not trading advice.</p>
    <p>A coin qualifies by either route:</p>
    <ul><li>Recognised elsewhere: a CoinGecko listing with an Elysium contract (chain 99901). Listing data from CoinGecko.</li>
      <li>Earned here: current rating Clear, no danger verdict ever observed, trading in a real pool after graduation or a Uniswap launch, age at least {criteria.minAgeDays} days, pool liquidity at least ${criteria.minLiquidityUsd.toLocaleString('en-US')}, and at least {criteria.minHolders} holders.</li></ul>
    <p>Qualifying route: {value.via.length ? value.via.map(v=>v==='coingecko' ? 'Recognised elsewhere · Listing data from CoinGecko' : 'Earned here').join(' and ') : 'None'}.</p>
    <p>Earned membership uses the latest rating block’s measurements and can change.</p>
  </div></details>;
}
