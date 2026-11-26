import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { z } from 'zod';
import { CHAIN_NETWORK, NETWORKS, RadarRowSchema, type EkoScore, type Flow, type RadarRow } from '@eko/shared';
import { ChartStage } from '../../components/chart/ChartStage';
import type { CoinTimeframe } from '../../components/chart/coinMath';
import { CoinDetailScope, CoinSlotScope, TabSections, WalletSlots, useTabSections } from '../../components/coinSlots';
import { PixelGauge } from '../../components/GlanceTile';
import { IconAlert, IconCheck, IconCopy, IconInfo, IconOct, IconOut } from '../../components/icons';
import { TradePanel } from '../../components/trade/TradePanel';
import { antiSnipeDeadline } from '../../components/trade/tradePanelModel';
import { Seg, TabPanel, Tabs, UntrustedText, inertText } from '../../components/ui';
import { WatchButton } from '../../components/WatchButton';
import { launchpadLabel } from '../../copy/chain';
import { featureLink, type CoinDetailTab } from '../../features';
import { fetchParsed } from '../../lib/api';
import { CHAIN_KEY } from '../../lib/chain';
import { serverNow } from '../../lib/clock';
import { coinElsewhere } from '../../lib/coinLinks';
import { knownCoinIdentity } from '../../lib/coinIdentity';
import { formatCoinPrice } from '../../lib/format';
import { Link } from '../../lib/Link';
import { navigate } from '../../lib/router';
import { CoinVerdict } from '../../pages/terminal/CoinCard';
import { Roll } from '../../pages/terminal/radarMotion';
import { coinVerdictActivity } from '../../pages/terminal/radarModel';
import { useCoin } from '../../pages/terminal/useCoin';
import { useGuardCoin } from '../../pages/terminal/useGuardCoin';
import { useApp } from '../../store/app';
import { useShell } from '../../store/shell';
import { useSimple } from './choice';
import { answerOf, holdersFlagged, reasonsOf, type Reason, type Tone } from './model';
import { AnswerChip, Ticker } from './parts';
import { STEER, TRADE_FILTERS, ageShort, changeChips, countShort, filterTrades, flowBox, headerStats, holderStats, signedPct, stripFacts, totalSupply, tradeRows, usdShort, type Glance, type TradeFilter } from './trader';
import { Walkthrough, coinWalk } from './Walkthrough';
import '../../pages/terminal/radar.css';
import '../../pages/terminal/coin.css';
import './simple.css';
import './trader.css';

const EXPLORER = NETWORKS[CHAIN_NETWORK[CHAIN_KEY]].explorerUrl;
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const TONE_ICON: Record<Tone, ComponentType<{ size?: number }>> = { good: IconCheck, watch: IconAlert, bad: IconOct, neutral: IconInfo };
const WINDOWS: Flow['window'][] = ['5m', '1h', '24h'];

export default function SimpleCoin({ params }: { params: Record<string, string> }) {
  return <SimpleCoinPage key={params.address} address={params.address!} />;
}

/**
 * Simple's coin page in the dense layout memecoin traders know: a stats strip (market cap, price, liquidity, volume,
 * supply, curve, tax, changes), EKO's answer right under it, the coin page's own chart, a flow box, the guarded trade
 * panel and holder stats beside it, and tabs of trades and reasons under the chart. The head and EKO's strip draw from
 * the coin card and radar row as soon as they arrive; the chart and the tabs fill in after.
 */
function SimpleCoinPage({ address }: { address: string }) {
  const [tf, setTf] = useState<CoinTimeframe>('5m'), [tab, setTab] = useState('Trades');
  const data = useCoin(address, tf), guardData = useGuardCoin(address);
  const ws = useShell(s => s.wsState), config = useShell(s => s.config), delayed = useShell(s => s.delayedSec), toast = useApp(s => s.toast);
  const [row, setRow] = useState<RadarRow | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    void fetchParsed('/radar', z.object({ rows: z.array(RadarRowSchema) }), { signal: ac.signal })
      .then(r => setRow(r.rows.find(c => c.address.toLowerCase() === address.toLowerCase()) ?? null)).catch(() => undefined);
    return () => ac.abort();
  }, [address]);
  const { card, verdict, bars, markers, flows } = data;
  const identity = card?.identity ?? guardData.card?.identity ?? knownCoinIdentity(address);
  const guard = guardData.assessment?.mode === 'active' ? guardData.assessment : verdict?.guardV2?.mode === 'active' ? verdict.guardV2 : null;
  const answer = answerOf({ level: verdict?.level ?? 'pending', historyPartial: verdict?.historyPartial, guard });
  const keystones = reasonsOf(verdict, guard, card), allReasons = reasonsOf(verdict, guard, card, 12);
  const dont = answer.kind === 'dont';
  const px = row?.priceUnavailable ? undefined : bars.at(-1)?.c ?? row?.priceUsd;
  const symbol = identity ? inertText(identity.symbol.text) : undefined;
  const head = headerStats(card, row, flows, px, formatCoinPrice), chips = changeChips(row, bars);
  const flagged = holdersFlagged(allReasons), facts = stripFacts(card, verdict, flagged), holders = holderStats(card, verdict, flagged);
  const supply = totalSupply(card, row);
  const antiSnipeEndsAt = useMemo(() => antiSnipeDeadline(card, guardData.card, serverNow()), [card, guardData.card]);
  const steps = useMemo(() => coinWalk(dont), [dont]);
  const whosIn = useTabSections("Who's in").length > 0, odds = useTabSections('Odds').length > 0;
  const trades = useMemo(() => tradeRows(flows, supply, card?.identity.deployer), [flows, supply, card?.identity.deployer]);
  const tabs = ['Trades', ...(whosIn ? ['Holders'] : []), ...(odds ? ['Odds'] : []), 'Why EKO says this'];
  const detail = useMemo(() => ({ open: (name: CoinDetailTab) => setTab(name === "Who's in" ? 'Holders' : name === 'Odds' ? 'Odds' : 'Why EKO says this') }), []);
  const createdAt = card?.identity.createdAt ? Date.parse(card.identity.createdAt) : NaN;
  const ageSec = row?.ageSec ?? (Number.isFinite(createdAt) ? Math.max(0, (serverNow() - createdAt) / 1000) : undefined);
  const elsewhere = coinElsewhere(address, identity?.stage);
  const devLink = card ? featureLink('deployer', card.identity.deployer, config?.flags) : null;
  const copy = () => void navigator.clipboard?.writeText(address).then(() => toast({ kind: 'ok', title: 'Address copied' })).catch(() => undefined);
  const stale = ws !== 'open' || (!!guard && (data.ageSec > 30 || (card?.freshness.ageSec ?? 0) > 30));
  const delay = useShell(s => s.me?.entitlements.limits.realtime) === false ? Math.max(60, delayed) : delayed;

  if (data.unknown && !card && !verdict) return <div className="shell-page sv-page sv-coin">
    <div className="sv-empty"><p className="sv-big-line">EKO doesn't know this coin yet.</p><p>Check that the address is right, or try again in a minute.</p>
      <button type="button" className="sv-btn" onClick={() => data.retry()}>Check again</button></div>
  </div>;

  return <CoinSlotScope coin={address}><CoinDetailScope value={detail}>
    <div className={`shell-page coin-page sv-page sv-coin sv-tr sv-tr-${answer.kind}`}>
      {data.error && <div role="status" className="coin-error">{data.error} <button className="btn" onClick={data.retry}>Retry</button></div>}

      <header className="sv-tr-head">
        <div className="sv-tr-id">
          <h1 className="sv-tr-sym">{identity ? <Ticker symbol={identity.symbol} address={address} /> : short(address)}</h1>
          <div className="sv-tr-idline">
            {identity && <span className="sv-tr-name"><UntrustedText value={identity.name} /></span>}
            {ageSec !== undefined && <span className="sv-tr-age num">{ageShort(ageSec)}</span>}
            <button type="button" className="sv-tr-ca num" onClick={copy} title={`Copy ${address}`} aria-label={`Copy contract address ${address}`}>{short(address)}<IconCopy size={12} /></button>
          </div>
          <div className="sv-tr-links">
            {identity && <span className="sv-tr-pad">{launchpadLabel(identity.launchpad, identity.stage === 'graduated')}</span>}
            {elsewhere && <a href={elsewhere.href} target="_blank" rel="noopener noreferrer">{elsewhere.label}<IconOut size={11} /></a>}
            {devLink && <Link to={devLink}>Dev</Link>}
            <WatchButton kind="coin" target={address} />
          </div>
        </div>
        <div className="sv-tr-mc"><span className="sv-tr-label">MC</span><b className="num">{head.marketCap ?? '—'}</b></div>
        <dl className="sv-tr-stats">
          {head.stats.map(s => <div key={s.id} className={`sv-tr-stat${s.tone ? ` tone-${s.tone}` : ''}`}><dt>{s.label}</dt><dd className="num">{s.id === 'price' ? <Roll value={s.value} /> : s.value}</dd></div>)}
        </dl>
        {chips.length > 0 && <ul className="sv-tr-chips" aria-label="Price change">
          {chips.map(c => <li key={c.label} className={c.pct >= 0.05 ? 'up' : c.pct <= -0.05 ? 'down' : ''}><span>{c.label}</span><b className="num">{signedPct(c.pct)}</b></li>)}
        </ul>}
      </header>

      <section className={`sv-strip sv-strip-${answer.kind}`} aria-label="EKO says" aria-live="polite">
        <div className="sv-strip-answer">
          <span className="sv-tr-label">EKO says</span>
          <div className="sv-strip-line">
            <AnswerChip answer={answer} size="lg" walk="answer" />
            <span className="sv-steer">{STEER[answer.kind]}</span>
            {/* The EKO score (the card's, else the radar row's); the old Signal score never shows in Simple. */}
            <StripScore score={card?.ekoScore ?? row?.ekoScore} />

          </div>
          <ul className="sv-pills">{keystones.map(r => <Pill key={r.text} reason={r} />)}</ul>
        </div>
        {facts.length > 0 && <ul className="sv-strip-facts">{facts.map(f => <StripFact key={f.id} fact={f} />)}</ul>}
      </section>

      <div className="sv-tr-grid">
        <div className="sv-tr-left">
        <div className="sv-tr-chart">
          <ChartStage market={symbol ?? address} timeframe={tf} onTimeframe={setTf} bars={bars} markers={markers} supply={supply ?? 1}
            verdict={undefined} delayedSec={delay} labelsUnavailable={data.labelsUnavailable || card?.meta?.flow?.unavailable} crewsEnabled={config?.flags.rug_ring_radar} />
          {(!bars.length || data.candlesUnavailable) && !data.error && <p role="status" className="coin-chart-status">{data.candlesLoading ? 'Loading the chart…' : 'No trades in this view yet.'}</p>}
        </div>

        <section className="sv-tr-tabs" aria-label="Trades and details">
          <div className="coin-tabs"><Tabs tabs={tabs.map(t => ({ value: t, label: t === 'Trades' && trades.length ? `Trades ${trades.length}` : t }))} value={tab} onChange={setTab} label="Coin details" id="sv-details" /></div>
          {tabs.map((name, i) => <TabPanel key={name} id="sv-details" index={i} active={tab === name}>
            {name === 'Trades' ? <TradesTable rows={trades} loading={!flows.length} nowSec={Math.floor(serverNow() / 1000)} />
              : name === 'Holders' ? <TabSections tab="Who's in" />
              : name === 'Odds' ? <TabSections tab="Odds" />
              : <div className="sv-why">
                <ul className="sv-why-list">{allReasons.map(r => { const Icon = TONE_ICON[r.tone]; return <li key={r.text} className={`sv-reason sv-reason-${r.tone}`}><Icon size={16} /><span>{r.text}</span></li>; })}</ul>
                {verdict && <details className="sv-fold"><summary>The evidence behind it</summary>
                  <CoinVerdict verdict={verdict} {...(card ? { identity: card.identity, meta: card.meta, activity: coinVerdictActivity(card, serverNow()) } : {})} evidenceOpen />
                </details>}
                <TabSections tab="Overview" />
              </div>}
          </TabPanel>)}
        </section>
        </div>
        <div className="sv-tr-right">
        <FlowCard flows={flows} />
        <div className="sv-tr-trade" data-walk="buy">
          {dont ? <DontBuy symbol={symbol} panel={<TradeBox address={address} px={px} row={row} guard={guardData.assessment ?? verdict?.guardV2} stale={stale} symbol={symbol} antiSnipeEndsAt={antiSnipeEndsAt} />} />
            : <TradeBox address={address} px={px} row={row} guard={guardData.assessment ?? verdict?.guardV2} stale={stale} symbol={symbol} antiSnipeEndsAt={antiSnipeEndsAt} />}
        </div>
        {holders.length > 0 && <section className="sv-box sv-holders" aria-labelledby="sv-holders-h">
          <h2 id="sv-holders-h" className="sv-box-title">Holders</h2>
          <ul className="sv-hgrid">{holders.map(h => { const Icon = TONE_ICON[h.tone]; return <li key={h.id} className={`tone-${h.tone}`}><span className="sv-hlabel">{h.label}</span><b className="num">{h.value}</b><Icon size={14} /></li>; })}</ul>
        </section>}

        </div>
      </div>
      <button type="button" className="sv-more" onClick={() => { useSimple.getState().choose('full'); window.scrollTo({ top: 0 }); }}>Open the full terminal for this coin</button>
      <Walkthrough walk="coin" steps={steps} ready={!!verdict && !!card} />
    </div>
  </CoinDetailScope></CoinSlotScope>;
}

/** Where the EKO score goes in EKO's strip. Renders nothing until the score's field is on the card and row. */
/** The EKO score after the steer: the figure, its band word and a gauge; the title says why it sits in its band. */
const SCORE_WORD: Record<EkoScore['band'], string> = { danger: 'Danger', careful: 'Careful', ok: 'OK' };
const SCORE_TONE = { danger: 'bad', careful: 'watch', ok: 'good' } as const;
function StripScore({ score }: { score: EkoScore | undefined }): ReactNode {
  if (!score) return null;
  const why = score.cappedBy ? `Capped at ${score.cap}: EKO says ${SCORE_WORD[score.band]}, ${score.cappedBy.toLowerCase()}.` : 'Inside its band a coin sits by its setup: momentum, money behind it, holder spread, how easy it is to exit.';
  return <span className={`sv-strip-score band-${score.band}`} title={`EKO score. Danger is always 0-39, Be careful 40-69, Looks OK 70-100. ${why}`}>
    <span className="sv-tr-label">EKO score</span><b className="num">{score.value}</b><i>{SCORE_WORD[score.band]}</i>
    <PixelGauge pct={score.value} tone={SCORE_TONE[score.band]} height={10} columns={20} />
  </span>;
}

function Pill({ reason }: { reason: Reason }) {
  const Icon = TONE_ICON[reason.tone];
  return <li className={`sv-pill tone-${reason.tone}`}><Icon size={13} /><span>{reason.text}</span></li>;
}
function StripFact({ fact }: { fact: Glance }) {
  return <li className={`sv-sfact tone-${fact.tone}`} data-walk={fact.id === 'sell' ? 'sell' : undefined}>
    <span className="sv-tr-label">{fact.label}</span>
    <b className="num">{fact.value}</b>
    {fact.gauge !== undefined ? <PixelGauge pct={fact.gauge} tone={fact.tone} height={10} columns={16} /> : <span className="sv-sfact-blank" aria-hidden="true" />}
  </li>;
}

function TradeBox({ address, px, row, guard, stale, symbol, antiSnipeEndsAt }: { address: string; px: number | undefined; row: RadarRow | null; guard: Parameters<typeof TradePanel>[0]['guard']; stale: boolean; symbol: string | undefined; antiSnipeEndsAt: number | undefined }) {
  return <section className="sv-box sv-trade-box" aria-label="Trade this coin">
    <div className="sv-box-head"><h2 className="sv-box-title">Trade</h2><span className="sv-box-sub">Your wallet signs · EKO never holds funds</span></div>
    <TradePanel coin={address} priceUsd={px} priceUnavailable={row?.priceUnavailable} priceFormat={formatCoinPrice} guard={guard} stale={stale}
      {...(antiSnipeEndsAt !== undefined ? { antiSnipeEndsAt } : {})} {...(symbol ? { symbol } : {})} />
  </section>;
}

/** On a coin EKO says not to buy: a safer coin first, and the trade panel only after a plain warning. */
function DontBuy({ symbol, panel }: { symbol: string | undefined; panel: ReactNode }) {
  const [anyway, setAnyway] = useState<'no' | 'asked' | 'yes'>('no');
  if (anyway === 'yes') return <>{panel}</>;
  return <section className="sv-box sv-dont-box" aria-label="EKO says steer clear">
    <span className="sv-tr-label">Steer clear</span>
    <p>EKO says don't buy {symbol ? `$${symbol}` : 'this coin'}. Most people who buy coins like this lose money.</p>
    <button type="button" className="sv-btn sv-btn-big" onClick={() => { useSimple.getState().setOnlyOk(true); navigate('/radar'); }}>Find a safer coin</button>
    {anyway === 'no' && <button type="button" className="sv-btn-link" onClick={() => setAnyway('asked')}>Buy anyway</button>}
    {anyway === 'asked' && <div className="sv-warn" role="alert">
      <p><b>EKO thinks this coin is a trap.</b> People who buy coins like this often lose all of it. Only buy with money you can lose.</p>
      <div className="sv-warn-actions"><button type="button" className="sv-btn sv-btn-quiet" onClick={() => setAnyway('yes')}>I understand, show the trade panel</button><button type="button" className="sv-btn-link" onClick={() => setAnyway('no')}>Never mind</button></div>
    </div>}
  </section>;
}

/** Buys against sells for one window, switchable between 5m, 1h and 24h. */
function FlowCard({ flows }: { flows: Flow[] }) {
  const [win, setWin] = useState<Flow['window']>('1h');
  const box = flowBox(flows, win);
  if (!flows.some(f => f.activity)) return null;
  const share = box && box.buys + box.sells ? box.buyUsd / Math.max(1, box.buyUsd + box.sellUsd) * 100 : 50;
  return <section className="sv-box sv-flow" aria-labelledby="sv-flow-h">
    <div className="sv-box-head"><h2 id="sv-flow-h" className="sv-box-title">Flow</h2><Seg options={WINDOWS} value={win} onChange={v => setWin(v as Flow['window'])} label="Flow window" /></div>
    {box ? <>
      <div className="sv-flow-vol"><span className="sv-tr-label">Vol</span><b className="num">{usdShort(box.vol)}</b></div>
      <div className="sv-split" role="img" aria-label={`Buys ${Math.round(share)}% of the dollars`}><span className="sv-split-buy" style={{ width: `${share}%` }} /><span className="sv-split-sell" /></div>
      <dl className="sv-flow-grid">
        <div className="buy"><dt>Buys</dt><dd className="num">{countShort(box.buys)} / {usdShort(box.buyUsd)}</dd></div>
        <div className="sell"><dt>Sells</dt><dd className="num">{countShort(box.sells)} / {usdShort(box.sellUsd)}</dd></div>
        <div className={box.net > 0 ? 'buy' : box.net < 0 ? 'sell' : ''}><dt>Net buy</dt><dd className="num">{box.net >= 0 ? '+' : '−'}{usdShort(Math.abs(box.net))}</dd></div>
        <div><dt>Buyers / sellers</dt><dd className="num">{countShort(box.buyers)} / {countShort(box.sellers)}</dd></div>
      </dl>
    </> : <p className="sv-note">No trading measured in this window yet.</p>}
  </section>;
}

function TradesTable({ rows, loading, nowSec }: { rows: ReturnType<typeof tradeRows>; loading: boolean; nowSec: number }) {
  const [filter, setFilter] = useState<TradeFilter>('all');
  const shown = filterTrades(rows, filter).slice(0, 80);
  if (loading) return <div className="skel coin-flow-skel" aria-label="Loading trades" />;
  if (!rows.length) return <p className="sv-note">No trades listed for the last 24 hours.</p>;
  return <div className="sv-trades">
    <div className="sv-trade-filters" role="group" aria-label="Show trades">{TRADE_FILTERS.map(f => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}</div>
    <div className="sv-trades-wrap"><table className="sv-trades-table">
      <thead><tr><th>Age</th><th>Type</th><th className="r">MC</th><th className="r">Amount</th><th className="r">Total</th><th>Trader</th></tr></thead>
      <tbody>{shown.map(t => <tr key={t.key} className={t.side}>
        <td className="num muted"><a href={`${EXPLORER}/tx/${t.tx}`} target="_blank" rel="noopener noreferrer" title="Open the transaction">{ageShort(nowSec - t.ts)}</a></td>
        <td className={`sv-side ${t.side}`}>{t.side === 'buy' ? 'Buy' : 'Sell'}</td>
        <td className="r num">{t.mc === null ? '' : usdShort(t.mc)}</td>
        <td className="r num">{countShort(t.tokens)}</td>
        <td className={`r num sv-side ${t.side}`}>{usdShort(t.usd)}</td>
        <td className="sv-trader">{t.wallet ? <><a className="addr" href={`${EXPLORER}/address/${t.wallet}`} target="_blank" rel="noopener noreferrer" title={t.wallet}>{short(t.wallet)}</a>{t.dev && <span className="sv-tag">DEV</span>}<WalletSlots wallet={t.wallet} /></> : <span className="muted">—</span>}</td>
      </tr>)}</tbody>
    </table></div>
    {!shown.length && <p className="sv-note">No trades of this kind in the list.</p>}
  </div>;
}
