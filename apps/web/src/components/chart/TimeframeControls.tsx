import { useRef } from 'react';
import { Seg } from '../ui';
import { COIN_TIMEFRAMES, type CoinTimeframe } from './coinMath';

const FULL_TIMEFRAMES = [...COIN_TIMEFRAMES.slice(0, 5), '30m', ...COIN_TIMEFRAMES.slice(5)] as const;
const EXTRA_TIMEFRAMES = COIN_TIMEFRAMES.filter(tf => tf !== '5m' && tf !== '15m');
export function TimeframeControls({ value, onChange }: { value: CoinTimeframe; onChange(tf: CoinTimeframe): void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const choose = (tf: CoinTimeframe) => {
    onChange(tf);
    if (menu.current) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); }
  };
  return <>
    <div className="coin-timeframes-full"><Seg options={FULL_TIMEFRAMES} value={value} onChange={tf => onChange(tf as CoinTimeframe)} label="Timeframe" /></div>
    <div className="coin-timeframes-compact" role="group" aria-label="Timeframe">
      <Seg options={['5m', '15m', { value: '30m', label: <span className="tf-thirty">30m</span> }]} value={value} onChange={tf => onChange(tf as CoinTimeframe)} label="Common timeframes" />
      <details className="coin-tf-more" ref={menu} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); menu.current!.open = false; menu.current!.querySelector('summary')?.focus(); } }}>
        <summary aria-label="More timeframes">More{EXTRA_TIMEFRAMES.includes(value as typeof EXTRA_TIMEFRAMES[number]) && <span> · {value}</span>}<span className="coin-tf-phone-current">{value === '30m' ? ' · 30m' : ''}</span></summary>
        <div className="coin-tf-menu" role="group" aria-label="Additional timeframes">
          {[...EXTRA_TIMEFRAMES, '30m' as const].map(tf => <button className={tf === '30m' ? 'coin-tf-phone-thirty' : undefined} type="button" key={tf} aria-pressed={value === tf} onClick={() => choose(tf)}>{tf}</button>)}
        </div>
      </details>
    </div>
  </>;
}
