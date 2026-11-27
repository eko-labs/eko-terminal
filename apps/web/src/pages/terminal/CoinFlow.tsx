import { CHAIN_NETWORK, NETWORKS, type ChartMarker, type Flow, type FlowActivity, type FlowTrade, type FlowWallet } from '@eko/shared';
import { LedWait, WALLET_LABEL_WORD } from '../../components/ui';
import { Glyph } from '../../components/chart/FlowLayer';
import { CHAIN_KEY } from '../../lib/chain';
import { uniqueKeys } from '../../lib/keys';
import { NOT_CHECKED } from '../../copy/availability';
import { FlowBar, WINDOW_WORD, buyShare, flowUsd } from './FlowBar';
import { WalletSlots } from '../../components/coinSlots';

/**
 * The coin page's Flow and Trades tabs. Buy and sell flow is measured from the coin's on-chain trades and token
 * transfers (flow.activity); who the wallets are (agent, crew, human) shows only once wallets are labelled.
 */
const EXPLORER = NETWORKS[CHAIN_NETWORK[CHAIN_KEY]].explorerUrl;
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const clock = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 19);
export const ago = (sec: number) => sec < 60 ? `${Math.max(0, Math.round(sec))}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : sec < 86400 ? `${(sec / 3600).toFixed(1)}h` : `${(sec / 86400).toFixed(1)}d`;
export const RAW_TRADES_NOTE = 'Individual trades cover recent history. Older activity remains in the chart and coin summaries.';
export const FLOW_MEASURED_NOTE = 'Measured from on-chain trades and token transfers. A trade’s wallet is the one whose balance of the coin rose (buy) or fell (sell) in that transaction.';
export const LABELS_NOT_MEASURED = 'Who these wallets are (agent, crew or human) is not labelled yet, so no split is shown.';
const ORDER: Flow['window'][] = ['5m', '1h', '24h'];
const byWindow = (flows: Flow[]) => ORDER.map(w => flows.find(f => f.window === w)).filter((f): f is Flow => !!f);
const labelsMeasured = (f: Flow, unavailable?: boolean) => !unavailable && !f.meta?.unavailable;

function Wallet({ address }: { address: string }) {
  return <><a className="addr" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noopener noreferrer" title={address}>{short(address)}</a><WalletSlots wallet={address} /></>;
}
function Side({ side }: { side: 'buy' | 'sell' }) { return <span className={`coin-side ${side}`}>{side === 'buy' ? 'Buy' : 'Sell'}</span>; }

/** Buy vs sell per window: one row each for 5m, 1h and 24h. */
export function FlowWindows({ flows, labelsUnavailable, compact = false }: { flows: Flow[]; labelsUnavailable?: boolean; compact?: boolean }) {
  const rows = byWindow(flows);
  if (!rows.length) return <LedWait className="coin-flow-skel" label="Loading flow" text="Reading the flow…" />;
  if (!rows.some(f => f.activity) && !rows.some(f => labelsMeasured(f, labelsUnavailable))) return <p className="coin-empty">{NOT_CHECKED} · buy and sell flow is not measured for this coin.</p>;
  if (rows.every(f => f.activity && f.activity.buys + f.activity.sells === 0)) return <p className="coin-empty">No trades in the last 24 hours.</p>;
  return <div className={`coin-flow-windows${compact ? ' compact' : ''}`} role="table" aria-label="Buy and sell flow by window">
    <div className="cfw-row cfw-head" role="row"><span role="columnheader">Window</span><span role="columnheader">Buys vs sells</span><span role="columnheader" className="r">Buys</span><span role="columnheader" className="r">Sells</span><span role="columnheader" className="r">Net</span>{!compact && <span role="columnheader" className="r">Wallets</span>}</div>
    {rows.map(f => <WindowRow key={f.window} flow={f} labelsUnavailable={labelsUnavailable} compact={compact} />)}
  </div>;
}
function WindowRow({ flow, labelsUnavailable, compact }: { flow: Flow; labelsUnavailable?: boolean; compact: boolean }) {
  const a = flow.activity, labels = labelsMeasured(flow, labelsUnavailable);
  if (!a) return <div className="cfw-row" role="row"><span role="cell" className="cfw-w">{flow.window}</span><span role="cell" className="cfw-span">{labels ? <FlowBar flow={flow} legend /> : <span className="muted">{NOT_CHECKED}</span>}</span></div>;
  const share = buyShare(a);
  if (a.buys + a.sells === 0) return <div className="cfw-row" role="row"><span role="cell" className="cfw-w">{flow.window}</span><span role="cell" className="cfw-span muted">No trades in the last {WINDOW_WORD[flow.window]}</span></div>;
  return <div className="cfw-row" role="row">
    <span role="cell" className="cfw-w">{flow.window}</span>
    <span role="cell" className="cfw-bar"><FlowBar flow={flow} unavailable compact /><span className="num muted">{share}% buys</span></span>
    <span role="cell" className="r num">{flowUsd(a.buyUsd)}<small>{a.buys} {a.buys === 1 ? 'trade' : 'trades'}</small></span>
    <span role="cell" className="r num">{flowUsd(a.sellUsd)}<small>{a.sells} {a.sells === 1 ? 'trade' : 'trades'}</small></span>
    <span role="cell" className={`r num${a.netUsd > 0 ? ' up' : a.netUsd < 0 ? ' down' : ''}`}>{a.netUsd > 0 ? '+' : ''}{flowUsd(a.netUsd)}</span>
    {!compact && <span role="cell" className="r num">{a.buyers} / {a.sellers}<small>buyers / sellers</small></span>}
    {labels && <span role="cell" className="cfw-span"><FlowBar flow={{ ...flow, activity: undefined }} legend /></span>}
  </div>;
}

function WalletList({ title, wallets, nowSec, empty }: { title: string; wallets: FlowWallet[]; nowSec: number; empty: string }) {
  return <div className="coin-wallets"><h4>{title}</h4>{wallets.length ? <ol>{wallets.map(w => <li key={`${w.side}:${w.wallet}`}>
    <Wallet address={w.wallet} /><b className="num">{flowUsd(w.usd)}</b><span className="muted num">{w.trades} {w.trades === 1 ? 'trade' : 'trades'} · {ago(nowSec - w.lastTs)} ago</span>
  </li>)}</ol> : <p className="coin-empty">{empty}</p>}</div>;
}
/** The hour's largest buyers and sellers by USD, from the 1h flow. */
export function LargestWallets({ flow, markers, nowSec }: { flow: Flow | undefined; markers: ChartMarker[]; nowSec: number }) {
  const a: FlowActivity | undefined = flow?.activity;
  if (!flow) return <LedWait className="coin-flow-skel" label="Loading wallets" text="Reading the wallets…" />;
  if (!a) {
    // Labelled markers, where a server serves them.
    const recent = markers.filter(m => m.ts >= nowSec - 3600).sort((x, y) => y.sizeUsd - x.sizeUsd).slice(0, 6);
    return recent.length ? <MarkerTable markers={recent} /> : <p className="coin-empty">{NOT_CHECKED} · buy and sell flow is not measured for this coin.</p>;
  }
  if (a.buys + a.sells === 0) return <p className="coin-empty">No trades in the last hour.</p>;
  const largest = a.largest ?? [], buyers = largest.filter(w => w.side === 'buy'), sellers = largest.filter(w => w.side === 'sell');
  return <><div className="coin-wallet-grid">
    <WalletList title="Buyers" wallets={buyers} nowSec={nowSec} empty={a.buys ? 'Buys in the last hour could not be matched to a wallet.' : 'No buys in the last hour.'} />
    <WalletList title="Sellers" wallets={sellers} nowSec={nowSec} empty={a.sells ? 'Sells in the last hour could not be matched to a wallet.' : 'No sells in the last hour.'} />
  </div>{a.unattributed > 0 && <p className="note">{a.unattributed} {a.unattributed === 1 ? 'trade' : 'trades'} in the hour could not be matched to a wallet; {a.unattributed === 1 ? 'it counts' : 'they count'} in volume only.</p>}</>;
}

/** Flow tab: buy and sell per window, then the hour's largest wallets. */
export function CoinFlowTab({ flows, markers, labelsUnavailable, nowSec }: { flows: Flow[]; markers: ChartMarker[]; labelsUnavailable?: boolean; nowSec: number }) {
  const hour = flows.find(f => f.window === '1h'), labels = flows.some(f => labelsMeasured(f, labelsUnavailable));
  return <div className="coin-flow-tab">
    <section className="panel coin-card-panel"><div className="panel-head coin-section-head"><h3>Buys vs sells</h3><span className="muted">5 minutes · 1 hour · 24 hours</span></div><div className="panel-body">
      <FlowWindows flows={flows} labelsUnavailable={labelsUnavailable} />
      <p className="note">{FLOW_MEASURED_NOTE}{labels ? ' Declared labels come from registry data; likely labels from on-chain behaviour. Estimates, not facts.' : ` ${LABELS_NOT_MEASURED}`}</p>
    </div></section>
    <section className="panel coin-card-panel"><div className="panel-head coin-section-head"><h3>Largest wallets in the last hour</h3>{!!hour?.activity && hour.activity.buys + hour.activity.sells > 0 && <span className="muted num">{hour.activity.buyers} {hour.activity.buyers === 1 ? 'buyer' : 'buyers'} · {hour.activity.sellers} {hour.activity.sellers === 1 ? 'seller' : 'sellers'}</span>}</div><div className="panel-body">
      <LargestWallets flow={hour} markers={markers} nowSec={nowSec} />
    </div></section>
  </div>;
}

function MarkerTable({ markers }: { markers: ChartMarker[] }) {
  return <div className="coin-table-wrap"><table className="table"><thead><tr><th>Time</th><th>Side</th><th>Who</th><th>Wallet</th><th className="r">Size</th></tr></thead><tbody>{markers.map((m, i) => <tr key={i}><td className="num muted">{clock(m.ts)}</td><td><Side side={m.side} /></td><td><Glyph label={m.label} /> {WALLET_LABEL_WORD[m.label]}</td><td><Wallet address={m.wallet} /></td><td className="r num">{flowUsd(m.sizeUsd)}</td></tr>)}</tbody></table></div>;
}
/** Trades tab: labelled markers when served, else the latest trades of the 24h flow. */
export function CoinTrades({ markers, flows, labelsUnavailable }: { markers: ChartMarker[]; flows: Flow[]; labelsUnavailable?: boolean }) {
  const day = flows.find(f => f.window === '24h'), recent: FlowTrade[] = day?.activity?.recent ?? [];
  const labelled = !labelsUnavailable && markers.length > 0, recentKeys = uniqueKeys(recent, t => `${t.tx}:${t.side}:${t.ts}`);
  return <section className="panel coin-card-panel"><div className="panel-head coin-section-head"><h3>Latest trades</h3><span className="muted">{labelled ? 'Labelled wallets' : 'Last 24 hours, newest first'}</span></div><div className="panel-body">
    {labelled ? <MarkerTable markers={markers.slice(-32).reverse()} />
      : !day ? <LedWait className="coin-flow-skel" label="Loading trades" text="Reading the trades…" />
      : !day.activity ? <p className="coin-empty">{NOT_CHECKED} · trades are not listed for this coin.</p>
      : !recent.length ? <p className="coin-empty">No trades in the last 24 hours.</p>
      : <div className="coin-table-wrap"><table className="table coin-trades"><thead><tr><th>Time (UTC)</th><th>Side</th><th>Wallet</th><th className="r">Size</th><th className="r">Tx</th></tr></thead><tbody>{recent.map((t, i) => <tr key={recentKeys[i]}>
        <td className="num muted">{clock(t.ts)}</td><td><Side side={t.side} /></td><td>{t.wallet ? <Wallet address={t.wallet} /> : <span className="muted">Not matched</span>}</td><td className="r num">{flowUsd(t.usd)}</td>
        <td className="r"><a className="addr" href={`${EXPLORER}/tx/${t.tx}`} target="_blank" rel="noopener noreferrer" title={t.tx}>{t.tx.slice(0, 8)}…</a></td></tr>)}</tbody></table></div>}
    <p className="note">{RAW_TRADES_NOTE}</p>
  </div></section>;
}
