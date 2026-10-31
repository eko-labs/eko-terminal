import { useState } from 'react';
import type { WatchBody } from '@eko/shared';
import { useWatch, watchKey } from '../../store/watch';
import { useShell } from '../../store/shell';
import { Link } from '../../lib/Link';
import { UntrustedText } from '../../components/ui';
import { ConnectWatch } from '../../components/WatchButton';
import { NotificationSettings } from '../../components/NotificationSettings';
import './watch.css';
export function WatchGroups({ items, crews, pending, remove }: { items: WatchBody[]; crews: boolean; pending: string[]; remove: (item: WatchBody) => void }) {
  return <div className="watch-groups">{(['coin', 'wallet', ...(crews ? ['crew'] : [])] as WatchBody['kind'][]).map(kind => {
    const rows = items.filter(item => item.kind === kind);
    return <section className="panel panel-body" key={kind}><h2>{({ coin: 'Coins', wallet: 'Wallets', crew: 'Crews' })[kind]}</h2>{rows.length ? <ul>{rows.map(item => <li key={watchKey(item)}><Link to={`/${kind === 'coin' ? 'coin' : kind === 'wallet' ? 'scan' : 'crews'}/${encodeURIComponent(item.target)}`}><UntrustedText value={{ text: item.target, flags: [], truncated: false }} /></Link><button className="btn" disabled={pending.includes(watchKey(item))} onClick={() => remove(item)}>Remove <span className="sr">{kind} watch</span></button></li>)}</ul> : <p className="muted">No {kind} watches yet.</p>}</section>;
  })}</div>;
}
export default function Watch() {
  const owner = useWatch(s => s.owner), items = useWatch(s => s.items), error = useWatch(s => s.error), loading = useWatch(s => s.loading), pending = useWatch(s => s.pending), crews = useShell(s => !!s.config?.flags.rug_ring_radar);
  const [kind, setKind] = useState<WatchBody['kind']>('coin'), [target, setTarget] = useState(''), [formError, setFormError] = useState<string | null>(null), [adding, setAdding] = useState(false);
  return <div className="shell-page watch-page"><div className="page-head"><h1>Watchlist</h1><p>Follow coins and wallets, and choose which alerts reach you.</p><button className="btn" onClick={() => window.dispatchEvent(new Event('eko:open-alerts'))}>Open alerts</button></div>{!owner ? <ConnectWatch /> : <>
    <form className="watch-add" aria-label="Add watch" onSubmit={e => {
      e.preventDefault(); setFormError(null); setAdding(true);
      void useWatch.getState().change({ kind, target }, false, crews).then(() => setTarget('')).catch(() => setFormError('Could not add watch. Check the target and try again.')).finally(() => setAdding(false));
    }}><label>Watch kind<select className="input" value={kind} onChange={e => setKind(e.target.value as WatchBody['kind'])}><option value="coin">Coin</option><option value="wallet">Wallet</option>{crews && <option value="crew">Crew</option>}</select></label><label>Target<input className="input" value={target} onChange={e => setTarget(e.target.value)} placeholder={kind === 'crew' ? 'Crew ID' : '0x… address'} required maxLength={128} /></label><button className="btn" disabled={loading || adding}>{adding ? 'Adding…' : 'Add watch'}</button></form>
    {formError && <p role="alert">{formError}</p>}{error && <p role="alert">{error} <button className="btn" onClick={() => void useWatch.getState().refresh().catch(() => {})}>Retry</button></p>}
    {loading ? <p role="status">Loading watches…</p> : <WatchGroups {...{ items, crews, pending }} remove={item => void useWatch.getState().change(item, true, crews).catch(() => {})} />}
    <section aria-labelledby="watch-notifications"><h2 id="watch-notifications">Notifications</h2><NotificationSettings /></section>
  </>}</div>;
}
