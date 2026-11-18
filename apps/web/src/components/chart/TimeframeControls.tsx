import { useRef } from 'react';
import { Seg } from '../ui';
import { COIN_TIMEFRAMES, type CoinTimeframe } from './coinMath';

/** Shown as buttons when the toolbar is narrow; the rest sit under More. */
const COMMON = ['1s', '1m', '5m', '15m'] as const;
const EXTRA = COIN_TIMEFRAMES.filter(tf => !(COMMON as readonly string[]).includes(tf));
export function TimeframeControls({ value, onChange }: { value: CoinTimeframe; onChange(tf: CoinTimeframe): void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const choose = (tf: CoinTimeframe) => {
    onChange(tf);
    if (menu.current) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); }
  };
  return <>
    <div className="coin-timeframes-full"><Seg options={COIN_TIMEFRAMES} value={value} onChange={tf => onChange(tf as CoinTimeframe)} label="Timeframe" /></div>
    <div className="coin-timeframes-compact" role="group" aria-label="Timeframe">
      <Seg options={COMMON} value={value} onChange={tf => onChange(tf as CoinTimeframe)} label="Common timeframes" />
      <details className="coin-tf-more" ref={menu} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); menu.current!.open = false; menu.current!.querySelector('summary')?.focus(); } }}>
        <summary aria-label="More timeframes">More{EXTRA.includes(value) && <span> · {value}</span>}</summary>
        <div className="coin-tf-menu" role="group" aria-label="Additional timeframes">
          {EXTRA.map(tf => <button type="button" key={tf} aria-pressed={value === tf} onClick={() => choose(tf)}>{tf}</button>)}
        </div>
      </details>
    </div>
  </>;
}
