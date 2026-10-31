import { useEffect, useRef, useState } from 'react';
import { useConnection } from 'wagmi';
import { z } from 'zod';
import { AddressSchema, PublicBagReportSchema, WatchBodySchema, type Address, type BagReport, type PublicBagReport } from '@eko/shared';
import { UntrustedText, VerdictChip } from '../../components/ui';
import { AnalysisPolicyNotice } from '../../components/PolicyLinks';
import { DYOR } from '../../copy';
import { api, ApiError, fetchParsed } from '../../lib/api';
import { bagCounts, bagPreview, pollBags, rowComplete, shareBags, type BagRow, type ShareOptions } from '../../lib/bags';
import { Link } from '../../lib/Link';
import { useOnboarding } from '../../store/onboarding';
import { useApp } from '../../store/app';
import { PLAYBOOK_NAMES, usd } from './radarModel';
import './bags.css';

const hidden: ShareOptions = { includeValues: false, includeWallet: false };
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
function RowVerdict({ row }: { row: BagRow }) {
  return <VerdictChip level={rowComplete(row) ? row.coin.verdict : 'pending'} verdictPending={row.status === 'pending'} evaluatedPlaybooks={row.coin.evaluatedPlaybooks} />;
}
export function BagMix({ report }: { report: PublicBagReport }) {
  const counts = bagCounts(report), total = report.holdings.length || 1;
  return <div className="bag-mix" role="img" aria-label={`Verdicts by coin count: ${counts.clear} No flags, ${counts.monitor} Monitor, ${counts.danger} Danger, ${counts.incomplete} not fully checked`}>
    {(['danger', 'monitor', 'clear', 'incomplete'] as const).map(level => <i key={level} className={level} style={{ width: `${counts[level] / total * 100}%` }} />)}
  </div>;
}
export function BagCard({ report }: { report: PublicBagReport }) {
  const counts = bagCounts(report);
  return <div className="bag-card" aria-label="Bag report card">
    <div className="bcd-top"><b>EKO</b><span>Bag report</span></div>
    <div className="bcd-hero"><b>{counts.matched}<span>/{report.holdings.length}</span></b><p>coins with confirmed<br />playbook matches</p></div>
    <BagMix report={report} />
    <div className="bags-counts">{(['clear', 'monitor', 'danger'] as const).map(level => <span key={level}><VerdictChip level={level} /><b>{counts[level]}</b></span>)}</div>
    {counts.incomplete > 0 && <p>{counts.incomplete} not fully checked; excluded from confirmed matches.</p>}
    <ul className="bcd-list">{report.holdings.map(row => <li key={row.coin.address}><span className="bcd-sym">$<UntrustedText value={row.coin.symbol} /></span>{row.valueUsd !== undefined && <span className="num">{usd(row.valueUsd)}</span>}<RowVerdict row={row} /></li>)}</ul>
    <div className="bcd-foot"><span className="addr">{report.wallet ? report.wallet : 'Wallet hidden'}</span><span>Block {report.asOfBlock.toLocaleString('en-US')}</span></div>
    <p className="note">{DYOR}</p>
    <p className="note">Indexed holdings only{report.cursor ? ' · more holdings exist beyond this page' : ''}. This report is a snapshot.</p>
  </div>;
}
export function BagsConnect() {
  return <div className="shell-page bags-page"><div className="page-head"><div><h1>Scan my bags</h1><p>Review the guard's checks for your indexed holdings.</p></div></div>
    <div className="bags-connect"><section className="panel bcx"><h2>Connect a wallet to scan what you hold</h2><p>EKO reads public balances. Sign in with Ethereum to view your own holdings.</p>
      <ul><li>Read-only scanning: no approvals or transfers.</li><li>Your wallet signs every trade. EKO never holds funds.</li><li>Values and wallet identity are hidden in shared reports unless you opt in separately.</li></ul>
      <button className="btn btn-primary" onClick={() => window.dispatchEvent(new Event('eko:open-wallet'))}>Connect wallet</button></section>
      <section className="panel bcx"><h2>What you get</h2><p>Verdicts, playbook evidence and measured exit costs when available, plus a shareable report card.</p><p>Incomplete checks remain visible. A verdict is not a recommendation.</p></section></div><AnalysisPolicyNotice /></div>;
}
export function BagHolding({ row, retry, busy, watching, watchAvailable, toggleWatch }: { row: BagReport['holdings'][number]; retry: () => void; busy: boolean; watching: boolean; watchAvailable: boolean; toggleWatch: () => void }) {
  const error = row.status === 'error' || row.status === 'unavailable' || !!row.error;
  const complete = rowComplete(row);
  return <li className="bag-holding">
    <div className="bag-card-top"><div className="bag-coin"><Link to={`/coin/${row.coin.address}`} className="bag-sym">$<UntrustedText value={row.coin.symbol} /></Link><UntrustedText value={row.coin.name} /></div>
      <VerdictChip level={complete ? row.coin.verdict : 'pending'} guard={row.coin.guardV2 ?? undefined} verdictPending={row.status === 'pending'} evaluatedPlaybooks={row.coin.evaluatedPlaybooks} /></div>
    {error && <p role="status">Couldn't scan — retry. <button className="btn btn-sm" onClick={retry} disabled={busy}>Retry scans on this page</button></p>}
    <dl className="bag-card-kv"><div><dt>Balance</dt><dd className="num">{row.balanceStatus && row.balanceStatus !== 'observed' ? 'Not checked yet' : row.balance ?? 'Not checked yet'}</dd></div>
      <div><dt>Value</dt><dd className="num">{row.valueUsd === undefined || row.unavailable?.includes('value') ? 'Not checked yet' : usd(row.valueUsd)}</dd></div>
      <div><dt>Exit cost at $1,000</dt><dd>{row.exitCost1kPct === null || row.unavailable?.includes('exitCost') ? 'Not checked yet' : `${row.exitCost1kPct.toFixed(1)}%`}</dd></div>
      <div><dt>Top playbook</dt><dd>{!complete ? 'Not fully checked' : row.playbooks[0] ? PLAYBOOK_NAMES[row.playbooks[0]] : 'None matched'}</dd></div></dl>
    <details><summary>Evidence and limits</summary><p>{!complete ? 'Some required checks have not run. Review the coin evidence before considering a trade.' : 'Open the coin to review playbook evidence and history.'}</p><p>Exit cost is the measured $1,000 reference size, not a quote for your full balance. Fees and actual-size simulation belong to the guarded sell panel.</p><Link to={`/coin/${row.coin.address}`}>Open coin evidence</Link></details>
    <div className="bag-actions">
      {/* TODO(spec): Task 077's shared guarded sell panel is absent on this branch. Keep sells unavailable until its existing-position handoff is integrated. */}
      <button className="btn btn-sm" disabled title="The shared guarded sell panel is not available yet">Sell through the guard</button>
      <button className="btn btn-sm" disabled={!watchAvailable || busy} aria-pressed={watching} onClick={toggleWatch}>{watching ? 'Watching' : 'Watch'}</button>
      <Link className="btn btn-sm" to={`/coin/${row.coin.address}`}>Open</Link>
    </div><p className="note">Sells unavailable until the shared guarded sell panel is available.</p>
  </li>;
}
export function BagTable({ report, busy, watch, watchAvailable, retry, toggleWatch }: { report: BagReport; busy: boolean; watch: Set<string>; watchAvailable: boolean; retry: () => void; toggleWatch: (address: Address) => void }) {
  return <div className="bags-table-wrap"><table className="table bags-table"><caption className="sr">Indexed holdings and guard checks</caption><thead><tr>{['Coin', 'Verdict', 'Balance', 'Value', 'Exit cost at $1,000', 'Top playbook', 'Actions'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{report.holdings.map(row => <tr key={row.coin.address}>
    <td><div className="bag-coin"><Link to={`/coin/${row.coin.address}`}>$<UntrustedText value={row.coin.symbol} /></Link><UntrustedText value={row.coin.name} /></div></td>
    <td><VerdictChip level={rowComplete(row) ? row.coin.verdict : 'pending'} guard={row.coin.guardV2 ?? undefined} verdictPending={row.status === 'pending'} evaluatedPlaybooks={row.coin.evaluatedPlaybooks} />{(row.error || row.status === 'error' || row.status === 'unavailable') && <p className="bag-fail">Couldn't scan — retry. <button className="btn btn-sm" disabled={busy} onClick={retry}>Retry scans on this page</button></p>}</td>
    <td className="num">{row.balanceStatus && row.balanceStatus !== 'observed' ? 'Not checked yet' : row.balance ?? 'Not checked yet'}</td>
    <td className="num">{row.valueUsd === undefined || row.unavailable?.includes('value') ? 'Not checked yet' : usd(row.valueUsd)}</td>
    <td>{row.exitCost1kPct === null || row.unavailable?.includes('exitCost') ? 'Not checked yet' : `${row.exitCost1kPct.toFixed(1)}%`}</td>
    <td>{!rowComplete(row) ? 'Not fully checked' : row.playbooks[0] ? PLAYBOOK_NAMES[row.playbooks[0]] : 'None matched'}</td>
    <td><div className="bag-actions"><button className="btn btn-sm" disabled title="The shared guarded sell panel is not available yet">Sell through the guard</button><button className="btn btn-sm" disabled={!watchAvailable || busy} aria-pressed={watch.has(row.coin.address)} onClick={() => toggleWatch(row.coin.address)}>{watch.has(row.coin.address) ? 'Watching' : 'Watch'}</button><Link className="btn btn-sm" to={`/coin/${row.coin.address}`}>Open</Link></div><details><summary>Evidence and limits</summary><p>Exit cost is a $1,000 reference, not your full-balance quote. Sells await the shared guarded sell panel.</p><Link to={`/coin/${row.coin.address}`}>Open coin evidence</Link></details></td>
  </tr>)}</tbody></table></div>;
}
export function OwnerReport({ wallet }: { wallet: Address }) {
  const [report, setReport] = useState<BagReport | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<Address>(), [run, setRun] = useState({ n: 0, retry: false });
  const [options, setOptions] = useState<ShareOptions>(hidden), [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState<Awaited<ReturnType<typeof shareBags>> | null>(null);
  const [watch, setWatch] = useState<Set<string>>(new Set()), [watchAvailable, setWatchAvailable] = useState(false), [watchBusy, setWatchBusy] = useState<string | null>(null);
  const toast = useApp(s => s.toast);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const ac = new AbortController(); lifetime.current = ac; return () => ac.abort(); }, []);
  useEffect(() => {
    const ac = new AbortController(); setBusy(true); setError('');
    void pollBags(wallet, cursor, run.retry, ac.signal, setReport).catch(e => { if (!ac.signal.aborted) { if (e instanceof ApiError && e.status === 401) { setReport(null); useApp.getState().set({ account: null }); } setError(e instanceof ApiError && e.status === 401 ? 'Sign in with your wallet to view holdings.' : 'Could not load bag checks. Retry to refresh this page.'); } }).finally(() => { if (!ac.signal.aborted) setBusy(false); });
    return () => ac.abort();
  }, [wallet, cursor, run]);
  useEffect(() => {
    const ac = new AbortController();
    void fetchParsed('/watch', z.object({ items: z.array(WatchBodySchema) }), { signal: ac.signal }).then(r => { if (!ac.signal.aborted) { setWatch(new Set(r.items.filter(i => i.kind === 'coin').map(i => i.target.toLowerCase()))); setWatchAvailable(true); } }).catch(() => { if (!ac.signal.aborted) setWatchAvailable(false); });
    return () => ac.abort();
  }, [wallet, run.n]);
  useEffect(() => { if (report && !busy && useApp.getState().account?.walletAddress === wallet.toLowerCase() && !report.holdings.some(row => row.status === 'pending')) useOnboarding.getState().markStep('scan_bags'); }, [report, busy]);
  const refresh = (retry = false) => { setShared(null); setRun(r => ({ n: r.n + 1, retry })); };
  const toggleWatch = async (address: Address) => {
    if (watchBusy) return;
    setWatchBusy(address);
    const exists = watch.has(address), signal = lifetime.current?.signal;
    try { await api('/watch', { method: exists ? 'DELETE' : 'POST', body: { kind: 'coin', target: address }, signal }); if (signal?.aborted) return; setWatch(w => { const next = new Set(w); if (exists) next.delete(address); else next.add(address); return next; }); }
    catch { if (!signal?.aborted) toast({ kind: 'error', title: 'Could not update Watch. Try again.' }); }
    finally { setWatchBusy(null); }
  };
  const share = async () => {
    setSharing(true); setError('');
    const signal = lifetime.current?.signal;
    try { const result = await shareBags(wallet, options, signal); if (!signal?.aborted) setShared(result); }
    catch { if (!signal?.aborted) setError('Could not create the report link. Retry Share bag report.'); }
    finally { if (!signal?.aborted) setSharing(false); }
  };
  const shareButton = <button className="btn btn-primary" disabled={sharing || busy || !!cursor || !report?.holdings.length} onClick={() => void share()}>{sharing ? 'Preparing report…' : 'Share bag report'}</button>;
  const preview = shared?.report ?? (report && bagPreview(report, options));
  const counts = report && bagCounts(report);
  return <div className="shell-page bags-page"><div className="page-head"><div><h1>Scan my bags</h1><p aria-live="polite">{counts ? `${counts.matched} of ${report!.holdings.length} indexed coins have confirmed playbook matches. ${counts.incomplete} not fully checked.` : 'Loading indexed holdings…'}</p></div><div className="bags-head-actions"><span className="addr">{short(wallet)}</span><button className="btn" disabled={busy || sharing} onClick={() => refresh()}>Refresh</button>{shareButton}</div></div>
    {error && <p role="alert">{error} <button className="btn" disabled={busy} onClick={() => refresh(true)}>Retry</button></p>}
    <p role="status">{busy ? 'Scanning indexed holdings…' : report?.holdings.some(r => r.status === 'pending') ? 'Scans are still pending. Refresh to check their progress.' : ''}</p>
    {report && <><div className="bags-stats"><section className="panel panel-body"><span>Total value on this page</span><strong className="num">{report.summary.valueUsd === undefined ? 'Not checked yet' : usd(report.summary.valueUsd)}</strong></section><section className="panel panel-body"><span>Verdicts by coin count</span><BagMix report={report} /></section><section className="panel panel-body"><span>Coverage</span><strong>Indexed candidates</strong><span className="note">Discovery is not an exhaustive wallet inventory.</span></section></div>
      <div className="bags-grid"><section className="panel bags-holdings"><div className="panel-head"><h2>Holdings</h2><span className="muted">As of block {report.asOfBlock.toLocaleString('en-US')}</span></div>
        {report.holdings.length ? <><BagTable report={report} busy={busy || sharing || watchBusy !== null} watch={watch} watchAvailable={watchAvailable} retry={() => refresh(true)} toggleWatch={address => void toggleWatch(address)} /><ul className="bag-holdings">{report.holdings.map(row => <BagHolding key={row.coin.address} row={row} retry={() => refresh(true)} busy={busy || sharing || watchBusy !== null} watching={watch.has(row.coin.address)} watchAvailable={watchAvailable} toggleWatch={() => void toggleWatch(row.coin.address)} />)}</ul></> : <div className="empty">No non-zero indexed holdings found. Unindexed coins may be absent.</div>}
        <div className="bag-actions panel-body">{cursor && <button className="btn" disabled={busy || sharing} onClick={() => { setReport(null); setShared(null); setCursor(undefined); }}>First page</button>}{report.cursor && <button className="btn" disabled={busy || sharing} onClick={() => { setReport(null); setShared(null); setCursor(report.cursor!); }}>Next page</button>}</div>
        {!watchAvailable && <p className="note panel-body">Watch service unavailable. Refresh to retry.</p>}</section>
        <aside className="bags-aside"><section className="panel"><div className="panel-head"><h2>Bag report card</h2><span>{shared ? 'Shared snapshot' : 'Preview'}</span></div><div className="panel-body">
          {cursor ? <p>Sharing covers the first page only. Return to the first page to preview and share it.</p> : preview && <BagCard report={preview} />}
          <fieldset className="bag-opts" disabled={sharing || !!cursor}><legend>Share disclosures</legend><label><span>Include values</span><input type="checkbox" checked={options.includeValues} onChange={e => { setShared(null); setOptions(o => ({ ...o, includeValues: e.target.checked })); }} /></label><label><span>Show wallet address</span><input type="checkbox" checked={options.includeWallet} onChange={e => { setShared(null); setOptions(o => ({ ...o, includeWallet: e.target.checked })); }} /></label></fieldset>
          <p className="note">Balance quantities are rounded. Values and wallet identity are separate opt-ins. Existing links retain their original disclosures; changing these options creates a new link.</p>{shareButton}
          {shared && <ShareLinks id={shared.id} />}
        </div></section></aside></div></>}
    <div className="bag-sticky">{shareButton}</div><AnalysisPolicyNotice /></div>;
}
export function ShareLinks({ id }: { id: string }) {
  const path = `/bags/r/${encodeURIComponent(id)}`, url = typeof location === 'undefined' ? path : `${location.origin}${path}`, toast = useApp(s => s.toast);
  return <div className="bag-share-links"><Link to={path}>Open shared report</Link><button className="btn" onClick={() => void navigator.clipboard.writeText(url).then(() => toast({ kind: 'ok', title: 'Report link copied' })).catch(() => toast({ kind: 'error', title: 'Could not copy. Open the shared report to copy its URL.' }))}>Copy link</button><a target="_blank" rel="noopener noreferrer" href={`https://x.com/intent/tweet?text=${encodeURIComponent(`EKO bag report. ${DYOR}`)}&url=${encodeURIComponent(url)}`}>Share on X</a><a target="_blank" rel="noopener noreferrer" href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(`EKO bag report. ${DYOR}`)}`}>Share on Telegram</a></div>;
}
function SharedReport({ id }: { id: string }) {
  const [report, setReport] = useState<PublicBagReport | null>(null), [error, setError] = useState(''), [run, setRun] = useState(0);
  useEffect(() => { const ac = new AbortController(); setError(''); void fetchParsed(`/bags/${encodeURIComponent(id)}`, PublicBagReportSchema, { signal: ac.signal }).then(r => { if (!ac.signal.aborted) setReport(r); }).catch(e => { if (!ac.signal.aborted) setError(e instanceof ApiError && e.status === 404 ? 'Bag report not found.' : 'Could not load this report.'); }); return () => ac.abort(); }, [id, run]);
  // App owns the server-projected share metadata; a lazy page must not overwrite it.
  return <div className="shell-page bags-page bag-public"><div className="page-head"><div><h1>Bag report</h1><p>Public snapshot · no wallet connection required</p></div><Link className="btn" to="/bags">Scan my bags</Link></div>{error ? <p role="alert">{error} <button className="btn" onClick={() => setRun(n => n + 1)}>Retry</button></p> : report ? <><BagCard report={report} /><ShareLinks id={id} /></> : <p role="status">Loading bag report…</p>}<AnalysisPolicyNotice /></div>;
}
export default function Bags({ params }: { params: Record<string, string> }) {
  if (params.id) return <SharedReport key={params.id} id={params.id} />;
  return <OwnedBags />;
}
function OwnedBags() {
  const connection = useConnection(), account = useApp(s => s.account);
  const address = AddressSchema.safeParse(connection.address?.toLowerCase());
  return address.success && account?.kind === 'wallet' && account.walletAddress?.toLowerCase() === address.data
    ? <OwnerReport key={address.data} wallet={address.data} /> : <BagsConnect />;
}
