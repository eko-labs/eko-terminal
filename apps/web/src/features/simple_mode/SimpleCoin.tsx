import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { RadarRowSchema, type RadarRow } from '@eko/shared';
import { GlanceRow } from '../../components/coinSlots';
import { GlanceTile } from '../../components/GlanceTile';
import { TradePanel } from '../../components/trade/TradePanel';
import { Seg, UntrustedText, inertText } from '../../components/ui';
import { WatchButton } from '../../components/WatchButton';
import { fetchParsed } from '../../lib/api';
import { knownCoinIdentity } from '../../lib/coinIdentity';
import { formatCoinPrice } from '../../lib/format';
import { navigate } from '../../lib/router';
import { Decode, Roll } from '../../pages/terminal/radarMotion';
import { pct } from '../../pages/terminal/radarModel';
import { useCoin } from '../../pages/terminal/useCoin';
import { useGuardCoin } from '../../pages/terminal/useGuardCoin';
import { useShell } from '../../store/shell';
import { useSimple } from './choice';
import { answerOf, factsOf, moveText, reasonsOf, whoIsBuying, type Tone } from './model';
import { AnswerChip, Reasons } from './parts';
import { RANGES, SimpleChart, barsIn, type Range } from './SimpleChart';
import { Walkthrough, coinWalk } from './Walkthrough';
import '../../pages/terminal/radar.css';
import '../../pages/terminal/coin.css';
import './simple.css';

const AMOUNTS = [10, 25, 50, 100] as const;
const BAND: Record<string, Tone> = { ok: 'good', careful: 'watch', dont: 'bad', checking: 'neutral' };

export default function SimpleCoin({ params }: { params: Record<string, string> }) {
  return <SimpleCoinPage key={params.address} address={params.address!} />;
}

/**
 * Simple's coin page, built from the Full page's own parts: the coin head with its live price, the glance band (the
 * answer and its reasons, then plain facts as Full's gauge tiles), the phosphor chart, who is buying, and one buy panel.
 * "Show me everything" opens the Full page for this coin.
 */
function SimpleCoinPage({ address }: { address: string }) {
  const [range, setRange] = useState<Range>('24h');
  const data = useCoin(address, RANGES[range].tf), guardData = useGuardCoin(address), ws = useShell(s => s.wsState);
  const [row, setRow] = useState<RadarRow | null>(null);
  const [buying, setBuying] = useState(false), [anyway, setAnyway] = useState<'no' | 'asked' | 'yes'>('no');
  const [amount, setAmount] = useState<{ usd: number; at: number } | null>(null);
  const tradeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ac = new AbortController();
    void fetchParsed('/radar', z.object({ rows: z.array(RadarRowSchema) }), { signal: ac.signal })
      .then(r => setRow(r.rows.find(c => c.address.toLowerCase() === address.toLowerCase()) ?? null)).catch(() => undefined);
    return () => ac.abort();
  }, [address]);
  const { card, verdict, bars, flows } = data;
  const identity = card?.identity ?? guardData.card?.identity ?? knownCoinIdentity(address);
  const guard = guardData.assessment?.mode === 'active' ? guardData.assessment : verdict?.guardV2?.mode === 'active' ? verdict.guardV2 : null;
  const answer = answerOf({ level: verdict?.level ?? 'pending', historyPartial: verdict?.historyPartial, guard });
  const reasons = reasonsOf(verdict, guard, card), facts = factsOf(card, row), who = whoIsBuying(flows);
  const dont = answer.kind === 'dont', checking = answer.kind === 'checking' || !verdict;
  const px = row?.priceUnavailable ? undefined : bars.at(-1)?.c ?? row?.priceUsd;
  const symbol = identity ? inertText(identity.symbol.text) : undefined;
  const shown = useMemo(() => barsIn(bars, range), [bars, range]);
  const changeOk = !!row && !row.unavailable?.includes('change');
  const first = shown[0], last = shown.at(-1);
  // The move over the chart's span; the day's is already in the head and the facts, so the chart names only its span.
  const move = range === '1h' ? (changeOk ? moveText(row!.change1hPct, '') : null)
    : range === 'all' && first && last && first.o > 0 ? moveText((last.c / first.o - 1) * 100, '') : null;
  const span = range === '1h' ? 'Price in the last hour' : range === '24h' ? 'Price today' : 'Price since EKO started watching';
  const steps = useMemo(() => coinWalk(dont), [dont]);
  const pick = (usd: number) => { setAmount({ usd, at: Date.now() }); requestAnimationFrame(() => tradeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); };
  const showBuy = buying && (!dont || anyway === 'yes');

  if (data.unknown && !card && !verdict) return <div className="shell-page sv-page sv-coin">
    <div className="sv-empty"><p className="sv-big-line">EKO doesn't know this coin yet.</p><p>Check that the address is right, or try again in a minute.</p>
      <button type="button" className="sv-btn" onClick={() => data.retry()}>Check again</button></div>
  </div>;

  return <div className={`shell-page sv-page sv-coin${dont ? ' sv-dont' : ''}`}>
    <header className="coin-head sv-coin-head">
      <div className="coin-title-row">
        <div className="coin-id">
          <h1>{identity ? <Decode text={`$${inertText(identity.symbol.text)}`}><span>$<UntrustedText value={identity.symbol} /></span></Decode> : 'This coin'}</h1>
          {identity && <span className="coin-name"><UntrustedText value={identity.name} /></span>}
        </div>
        <div className="coin-actions"><WatchButton kind="coin" target={address} /></div>
      </div>
      <dl className="coin-price">
        <div className="coin-stat coin-stat-price"><dt className="sr-only">Price</dt><dd><b>{px === undefined ? <span className="glance-wait" aria-label="Loading">—</span> : <Roll value={formatCoinPrice(px)} />}</b></dd></div>
        {changeOk && <div className="coin-stat"><dt>Last hour</dt><dd className={`num${row!.change1hPct > 0 ? ' up' : row!.change1hPct < 0 ? ' down' : ''}`}><Roll value={pct(row!.change1hPct)} /></dd></div>}
        {changeOk && row!.change24hPct !== undefined && <div className="coin-stat"><dt>Today</dt><dd className={`num${row!.change24hPct > 0 ? ' up' : row!.change24hPct < 0 ? ' down' : ''}`}><Roll value={pct(row!.change24hPct)} /></dd></div>}
      </dl>
    </header>

    <GlanceRow tone={BAND[answer.kind]} own={[
      { order: 0, node: <div className="sv-answer" data-walk="answer" aria-live="polite">
        <span className="gv-label">EKO says</span>
        <AnswerChip answer={answer} size="lg" />
        <Reasons reasons={reasons} />
      </div> },
      ...facts.map((f, i) => ({ order: 10 + i, node: <div className="sv-tile" data-walk={f.id === 'sell' ? 'sell' : undefined}>
        <GlanceTile label={f.label} value={f.value} line={f.line} tone={f.tone} {...(f.gauge !== undefined ? { gauge: f.gauge } : {})} />
      </div> })),
    ]} />

    <div className="coin-grid sv-grid">
      <div className="sv-main">
        <section className="sv-section" aria-labelledby="sv-price-h">
          <div className="sv-section-head">
            <h2 id="sv-price-h">{span}{move && <span className={`sv-move${move.startsWith('Up') ? ' up' : ''}`}>{move}</span>}</h2>
            <Seg options={(Object.keys(RANGES) as Range[]).map(r => ({ value: r, label: RANGES[r].label }))} value={range} onChange={v => setRange(v as Range)} label="How far back" />
          </div>
          <SimpleChart bars={shown} range={range} label={move ? `${span}: ${move.toLowerCase()}` : span} />
          {!shown.length && !data.candlesLoading && <p className="sv-note">Nobody traded it in this time. Try a longer view.</p>}
        </section>
        {who && <section className="sv-card sv-who" aria-labelledby="sv-who-h">
          <h2 id="sv-who-h" className="sv-kicker">Who's buying</h2>
          <p className="sv-card-lead">{who.text}</p>
          <div className="sv-split" role="img" aria-label={`${who.buyers} buying, ${who.sellers} selling in the last hour`}>
            <span className="sv-split-buy" style={{ width: `${who.share}%` }} /><span className="sv-split-sell" />
          </div>
          <p className="sv-split-key"><span><i className="buy" />{who.buyers.toLocaleString('en-US')} {who.buyers === 1 ? 'person' : 'people'} buying</span><span><i className="sell" />{who.sellers.toLocaleString('en-US')} selling</span><span className="sv-when">Last hour</span></p>
        </section>}
      </div>

      <aside className="sv-aside" aria-label="Buy this coin">
        <section className="sv-buy-panel">
          <div className="sv-buy-head">
            <span className="sv-kicker">{dont ? 'EKO says don’t buy' : 'Buy'}</span>
            <p>{dont ? 'Most people who buy coins like this lose money.' : 'Your own wallet signs. EKO never holds your money.'}</p>
          </div>
          {dont
            ? <>
              <button type="button" className="sv-btn sv-btn-big" data-walk="buy" onClick={() => { useSimple.getState().setOnlyOk(true); navigate('/radar'); }}>Find a safer coin</button>
              {anyway === 'no' && <button type="button" className="sv-btn-link" onClick={() => setAnyway('asked')}>Buy anyway</button>}
              {anyway === 'asked' && <div className="sv-warn" role="alert">
                <p><b>EKO thinks this coin is a trap.</b> People who buy coins like this often lose all of it. Only buy with money you can lose.</p>
                <div className="sv-warn-actions"><button type="button" className="sv-btn sv-btn-quiet" onClick={() => { setAnyway('yes'); setBuying(true); }}>I understand, let me buy</button><button type="button" className="sv-btn-link" onClick={() => setAnyway('no')}>Never mind</button></div>
              </div>}
            </>
            : <button type="button" className="sv-btn sv-btn-big" data-walk="buy" disabled={checking} aria-expanded={buying} onClick={() => setBuying(b => !b)}>
              {checking ? 'Wait for EKO to finish checking' : `Buy ${symbol ? `$${symbol}` : 'this coin'}`}
            </button>}
          {showBuy && <div className="sv-buy">
            <p className="sv-buy-q">How much do you want to put in?</p>
            <div className="sv-amounts" role="radiogroup" aria-label="Amount">{AMOUNTS.map(usd => <button key={usd} type="button" role="radio" aria-checked={amount?.usd === usd} onClick={() => pick(usd)}>${usd}</button>)}</div>
            {amount && <div ref={tradeRef} className="sv-trade">
              <p className="sv-buy-note">Check the details, then press the button. Your wallet asks you to confirm.</p>
              <TradePanel coin={address} priceUsd={px} priceUnavailable={row?.priceUnavailable} priceFormat={formatCoinPrice} guard={guardData.assessment ?? verdict?.guardV2} stale={ws !== 'open'}
                amountRequest={amount} sideRequest={{ side: 'buy', at: amount.at }} {...(symbol ? { symbol } : {})} />
            </div>}
          </div>}
        </section>
      </aside>
    </div>
    <button type="button" className="sv-more" onClick={() => { useSimple.getState().choose('full'); window.scrollTo({ top: 0 }); }}>Show me everything</button>
    <Walkthrough walk="coin" steps={steps} ready={!!verdict && !!card} />
  </div>;
}
