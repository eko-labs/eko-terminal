import { useEffect } from 'react';
import type { TradeOrder } from '@eko/shared';
import { UntrustedText } from '../../components/ui';
import { ORDERS_COPY as C } from '../../copy/orders';
import { SHELL_COPY } from '../../copy/shell';
import { MOCKS } from '../../lib/api';
import { installDither } from '../../lib/dither';
import { Link } from '../../lib/Link';
import { useWalletState } from '../../lib/walletState';
import { useApp } from '../../store/app';
import { explorerTxUrl, formatOrderTime, hasOpenOrders, orderAmounts, shortAddress, shortHash, statusTone } from './ordersModel';
import { useCoinNames, useOrders, type CoinName, type OrdersState } from './useOrders';
import './orders.css';

function CoinCell({ address, name }: { address: string; name?: CoinName }) {
  return <Link className="ord-coin" to={`/coin/${address}`} title={address}>
    {name ? <><b className="ord-sym">$<UntrustedText value={name.symbol} /></b><span className="ord-name"><UntrustedText value={name.name} /></span></>
      : <><b className="ord-sym addr">{shortAddress(address)}</b><span className="ord-name">{C.unnamed}</span></>}
  </Link>;
}
function Amount({ text, dir }: { text: string | null; dir: 'paid' | 'received' }) {
  return text === null ? <span className="ord-none" title={C.noFillTitle}>{C.noFill}</span>
    : <><span className="num">{text}</span> <span className="ord-dir">{C[dir]}</span></>;
}
function Status({ order }: { order: TradeOrder }) {
  const detail = order.errorCode ? C.errors[order.errorCode] : undefined;
  return <span className={`ord-status ${statusTone(order.status)}`}><i aria-hidden="true" /><span>{C.status[order.status]}{detail && <small>{detail}</small>}</span></span>;
}
function Tx({ hash }: { hash?: string }) {
  const url = explorerTxUrl(hash);
  return url ? <a className="ord-tx addr" href={url} target="_blank" rel="noopener noreferrer" aria-label={C.txLink(hash!)}>{shortHash(hash!)} ↗</a>
    : <span className="ord-none" title={C.noTx}>{C.noFill}</span>;
}
function When({ iso }: { iso: string }) {
  return <time className="num ord-time" dateTime={iso} title={iso}>{formatOrderTime(iso)}</time>;
}
const rowClass = (order: TradeOrder) => `ord-${order.side}${order.status === 'submitted' ? ' ord-open' : ''}`;

export function OrdersTable({ rows, names }: { rows: TradeOrder[]; names: Record<string, CoinName> }) {
  return <div className="ord-table-wrap"><table className="table ord-table"><caption className="sr">{C.caption}</caption>
    <thead><tr><th scope="col">{C.cols.time}</th><th scope="col">{C.cols.coin}</th><th scope="col">{C.cols.side}</th><th scope="col" className="r">{C.cols.native}</th><th scope="col" className="r">{C.cols.coin_amount}</th><th scope="col">{C.cols.status}</th><th scope="col">{C.cols.tx}</th></tr></thead>
    <tbody>{rows.map(order => { const a = orderAmounts(order); return <tr key={order.id} className={rowClass(order)}>
      <td><When iso={order.createdAt} /></td>
      <td><CoinCell address={order.coin} name={names[order.coin.toLowerCase()]} /></td>
      <td><span className={`ord-side ${order.side}`}>{C.side[order.side]}</span></td>
      <td className="r"><Amount {...a.native} /></td>
      <td className="r"><Amount {...a.coin} /></td>
      <td><Status order={order} /></td>
      <td><Tx hash={order.txHash} /></td>
    </tr>; })}</tbody></table></div>;
}
/** The same orders as cards, for narrow screens (the table is hidden there). */
export function OrderCards({ rows, names }: { rows: TradeOrder[]; names: Record<string, CoinName> }) {
  return <ul className="ord-cards" aria-label={C.caption}>{rows.map(order => { const a = orderAmounts(order), name = names[order.coin.toLowerCase()]; return <li key={order.id} className={rowClass(order)}>
    <div className="ord-card-top"><span className={`ord-side ${order.side}`}>{C.side[order.side]}</span><CoinCell address={order.coin} name={name} /><When iso={order.createdAt} /></div>
    <dl className="ord-card-kv">
      <div><dt>{C.cols.native}</dt><dd><Amount {...a.native} /></dd></div>
      <div><dt>{C.cols.coin_amount}</dt><dd><Amount {...a.coin} /></dd></div>
      <div><dt>{C.cols.status}</dt><dd><Status order={order} /></dd></div>
      <div><dt>{C.cols.tx}</dt><dd><Tx hash={order.txHash} /></dd></div>
    </dl>
  </li>; })}</ul>;
}
function Skeleton() {
  return <div className="panel ord-skel" aria-busy="true"><p role="status" className="sr">{C.loading}</p>
    {Array.from({ length: 6 }, (_, i) => <div key={i} className="ord-skel-row" aria-hidden="true"><i className="skel" /><i className="skel" /><i className="skel" /><i className="skel" /></div>)}</div>;
}
export function SignedOut() {
  return <div className="connect-card ord-connect"><p>{SHELL_COPY.connect}</p><button className="btn" onClick={() => window.dispatchEvent(new Event('eko:open-wallet'))}>{SHELL_COPY.wallet}</button></div>;
}

/** The page body for one state: signed out, loading, error, empty or the list. */
export function OrdersView({ state, names = {}, retry }: { state: OrdersState; names?: Record<string, CoinName>; retry: () => void }) {
  const rows = state.kind === 'ready' ? state.rows : [], open = rows.filter(r => r.status === 'submitted').length;
  return <div className="shell-page orders-page">
    <div className="page-head"><h1>{C.title}</h1><p>{C.intro}</p></div>
    {state.kind === 'signed_out' ? <SignedOut />
      : state.kind === 'loading' ? <Skeleton />
      : state.kind === 'error' ? <div className="panel ord-error" role="alert"><p>{C.error}</p><button className="btn" onClick={retry}>{C.retry}</button></div>
      : !rows.length ? <div className="empty panel ord-empty"><strong>{C.emptyTitle}</strong><span>{C.empty}</span><Link className="btn" to="/radar">{C.emptyCta}</Link></div>
      : <section className="panel ord-list" aria-labelledby="ord-count">
        <div className="panel-head ord-head"><h2 id="ord-count" className="num">{C.count(rows.length)}</h2>
          {hasOpenOrders(rows) ? <p role="status" className="ord-live"><i className="live-dot open" aria-hidden="true" />{C.pending(open)}</p> : <span />}
          <button className="btn btn-sm" disabled={state.refreshing} onClick={retry}>{C.refresh}</button></div>
        <OrdersTable rows={rows} names={names} /><OrderCards rows={rows} names={names} />
        <p className="note ord-note">{C.note}</p>
      </section>}
  </div>;
}

/** /orders: the signed-in wallet's orders, from GET /v1/trade/orders. */
export default function Orders() {
  // The wallet runtime tells a signed-in wallet from a stale session; load it without opening the wallet menu.
  useEffect(() => { if (!useWalletState.getState().requested) useWalletState.setState({ requested: true }); }, []);
  useEffect(() => installDither(), []);
  const account = useApp(s => s.account), address = useWalletState(s => s.address), ready = useWalletState(s => s.ready);
  const owner = MOCKS ? 'demo-account' : account?.kind === 'wallet' && address && account.walletAddress === address.toLowerCase() ? account.walletAddress : null;
  const { state, retry } = useOrders(owner);
  const names = useCoinNames(state.kind === 'ready' ? state.rows.map(r => r.coin) : []);
  // Until the wallet runtime reports, a returning user is not yet known to be signed out.
  const view: OrdersState = !owner ? (ready || MOCKS ? { kind: 'signed_out' } : { kind: 'loading' }) : state;
  return <OrdersView state={view} names={names} retry={retry} />;
}
