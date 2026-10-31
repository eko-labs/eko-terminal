import { useEffect, useState } from 'react';
import { DeployerHistorySchema, type DeployerHistory, type DeployerLaunch } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
import { Link } from '../../lib/Link';
import { UntrustedText, VerdictChip } from '../../components/ui';
import { PLAYBOOK_NAMES } from './radarModel';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const OUTCOME_TEXT: Record<string, string> = { rugged: 'Rugged', honeypot: 'Honeypot', dumped: 'Dumped', survived: 'Survived' };
const when = (iso: string | null) => iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';

/** One deployer's record on Elysium: its launches and its crew's, the strongest checks each got, and what became of them. */
export function DeployerView({ data }: { data: DeployerHistory }) {
  const s = data.summary, bad = s.outcomes.rugged + s.outcomes.honeypot + s.outcomes.dumped, graded = bad + s.outcomes.survived;
  return <div className="shell-page deployer-page">
    <header className="page-head"><span className="eyebrow">Deployer history</span><h1 className="addr" title={data.deployer}>{short(data.deployer)}</h1>
      <p>{s.launches.toLocaleString()} launch{s.launches === 1 ? '' : 'es'} on Elysium{s.firstLaunchAt ? ` since ${when(s.firstLaunchAt)}` : ''}; {s.traded.toLocaleString()} traded.
        {graded > 0 ? ` After a day, ${bad} of ${graded} traded launch${graded === 1 ? '' : 'es'} went bad (rugged, honeypot or dumped).` : ' No launch has a day-old outcome yet.'}</p>
    </header>
    <section className="panel panel-body"><h2>Outcomes after 24 hours</h2>
      <dl className="receipt-metadata">{(['rugged', 'honeypot', 'dumped', 'survived'] as const).map(k => <div key={k}><dt>{OUTCOME_TEXT[k]}</dt><dd className="num">{s.outcomes[k]}</dd></div>)}
        <div><dt>Flagged Danger</dt><dd className="num">{s.flagged}</dd></div></dl>
      <p className="muted">Rugged: the price fell 90% or more from its peak while launch insiders sold. Dumped: the deployer and the first minute's buyers sold over half within an hour. Launches nobody traded have no outcome.</p>
    </section>
    <section className="panel panel-body"><h2>Funding and crew</h2>
      {data.funder ? <p>Funded by <span className="addr" title={data.funder.address}>{short(data.funder.address)}</span>{data.funder.fundedAt ? ` on ${when(data.funder.fundedAt)}` : ''}
        {data.funder.hub ? ' — a hub that funded many wallets, so it links no crew.' : '.'}</p>
        : <p className="muted">{data.funderStatus === 'pending' ? 'Funding is being traced; check back in a minute.' : 'No incoming HYPE transfer funded this wallet (it may have bridged in).'}</p>}
      {data.crew ? <p>Same funder as {data.crew.deployers.length} other deployer{data.crew.deployers.length === 1 ? '' : 's'}: {data.crew.deployers.slice(0, 12).map(d => <Link key={d} to={`/deployer/${d}`} className="addr">{short(d)} </Link>)}</p>
        : data.funder && !data.funder.hub && <p className="muted">No other deployer shares this funder.</p>}
    </section>
    <section className="panel"><div className="panel-head"><h2>Launches</h2></div><div className="coin-table-wrap"><table className="table">
      <caption className="sr">Launches by this deployer and its crew</caption>
      <thead><tr>{['Launched', 'Coin', 'By', 'Swaps', 'First check', 'Strongest flags', '1 h', '24 h'].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{data.launches.map(l => <LaunchRow key={l.address} l={l} />)}</tbody></table></div>
      {!data.launches.length && <p className="panel-body muted">No launches recorded for this wallet.</p>}
    </section>
    <p className="muted">Records start {when(data.coverage.since)} (Elysium's first Montra launch). Launches EKO did not watch live were rebuilt from their logs, without a sell check.</p>
  </div>;
}

function LaunchRow({ l }: { l: DeployerLaunch }) {
  return <tr>
    <td className="num muted">{when(l.createdAt)}</td>
    <td><Link to={`/coin/${l.address}`}><UntrustedText value={l.symbol} /></Link></td>
    <td>{l.relation === 'crew' ? <Link to={`/deployer/${l.deployer}`} className="addr">crew {short(l.deployer)}</Link> : 'this wallet'}</td>
    <td className="num">{l.swaps ?? '—'}</td>
    <td>{l.firstLevel ? <VerdictChip level={l.firstLevel} /> : <span className="muted">{l.source === null ? 'not checked' : '—'}</span>}{l.source === 'replay' && <span className="muted"> replayed</span>}</td>
    <td>{l.flags.length ? l.flags.slice(0, 3).map(f => <span key={f.id} className={f.level === 'danger' ? 'bad' : undefined}>{PLAYBOOK_NAMES[f.id] ?? f.id} </span>) : <span className="muted">none</span>}</td>
    <td>{l.outcome1h ? OUTCOME_TEXT[l.outcome1h] : '—'}</td>
    <td className={l.outcome24h && l.outcome24h !== 'survived' ? 'bad' : undefined}>{l.outcome24h ? OUTCOME_TEXT[l.outcome24h] : '—'}</td>
  </tr>;
}

export default function Deployer({ params }: { params: Record<string, string> }) {
  const address = params.address ?? '';
  const [data, setData] = useState<DeployerHistory | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    const ac = new AbortController(); setData(null); setError(false);
    void fetchParsed(`/deployers/${encodeURIComponent(address)}`, DeployerHistorySchema, { signal: ac.signal }).then(setData).catch(() => { if (!ac.signal.aborted) setError(true); });
    return () => ac.abort();
  }, [address]);
  if (error) return <div className="shell-page"><p role="alert">This deployer's history is unavailable. Refresh to retry.</p></div>;
  if (!data) return <div className="shell-page"><p role="status">Loading deployer history…</p></div>;
  return <DeployerView data={data} />;
}
