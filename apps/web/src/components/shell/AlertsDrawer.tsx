import { useEffect, useRef, useState } from 'react';
import type { Alert } from '@eko/shared';
import { useDialog } from '../onboarding/useDialog';
import { UntrustedText } from '../ui';
import { useWatch } from '../../store/watch';
import { Link } from '../../lib/Link';
import { ConnectWatch } from '../WatchButton';
import '../../pages/terminal/watch.css';
export function AlertList({ alerts }: { alerts: Alert[] }) {
  return alerts.length ? <ul className="watch-alerts">{alerts.map(alert => <li key={alert.id}>
    <h3><UntrustedText value={{ text: alert.title, flags: [], truncated: false }} /></h3>
    {alert.symbol && <UntrustedText value={alert.symbol} />}<p><UntrustedText value={{ text: alert.body, flags: [], truncated: false }} /></p>
    <time dateTime={alert.ts}>{new Date(alert.ts).toLocaleString('en-US', { timeZone: 'UTC' })} UTC</time>
    {alert.coin && <Link to={`/coin/${alert.coin}`}>Open coin</Link>}
  </li>)}</ul> : <p className="empty">No alerts yet. Watch a coin or wallet to follow its events.</p>;
}
function Drawer({ close }: { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null), owner = useWatch(s => s.owner), alerts = useWatch(s => s.alerts), error = useWatch(s => s.alertError);
  useDialog(ref, { onEscape: close });
  return <div className="watch-overlay" onClick={e => { if (e.target === e.currentTarget) close(); }}><div ref={ref} className="watch-drawer" role="dialog" aria-modal="true" aria-labelledby="alerts-title" tabIndex={-1}><div className="watch-inline"><h2 id="alerts-title">Alerts</h2><button className="btn" data-autofocus onClick={close}>Close alerts</button></div>{!owner ? <ConnectWatch /> : <>{error && <p role="alert">{error} <button className="btn" onClick={() => void useWatch.getState().resyncAlerts().catch(() => {})}>Retry alerts</button></p>}<AlertList alerts={alerts} /><Link to="/watch" onClick={close}>Manage watches and notifications</Link></>}</div></div>;
}
export function AlertsDrawer() {
  const [open, setOpen] = useState(false);
  useEffect(() => { const show = () => setOpen(true); window.addEventListener('eko:open-alerts', show); return () => window.removeEventListener('eko:open-alerts', show); }, []);
  return open ? <Drawer close={() => setOpen(false)} /> : null;
}
