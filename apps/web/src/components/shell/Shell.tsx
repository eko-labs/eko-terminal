import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ScanResultSchema } from '@eko/shared';
import { BUILT_ON, DYOR, NON_AFFILIATION } from '../../copy';
import { APP_NAME, SHELL_COPY as C, RISK_OPTIONS } from '../../copy/shell';
import { CHAIN_NAME, CHAIN_TITLE } from '../../copy/chain';
import { fetchParsed, MOCKS } from '../../lib/api';
import { Link } from '../../lib/Link';
import { navigate, usePath } from '../../lib/router';
import { onHeaderBackgroundClick } from '../../lib/mainFocus';
import { isCurrent, resolveRoute } from '../../routes';
import { useApp } from '../../store/app';
import { useShell } from '../../store/shell';
import { useUi } from '../../store/ui';
import { WalletButton } from '../Header';
import { LogoMark } from '../brand';
import { useNow } from '../hooks';
import { Seg } from '../ui';
import { PolicyLinks } from '../PolicyLinks';
import { IconRadar, IconPairs, IconSearch, IconAgent, IconMenu } from '../icons';
import { navGroups, breadcrumbTrail } from './navigation';

// A real link, not a router Link: "/" is the landing, served by the host (and by vite.config.ts in dev), not the SPA.
export function BrandLink() { return <a href="/" className="apphdr-brand" aria-label={`${APP_NAME}: back to the site`}><LogoMark />{APP_NAME}</a>; }
export function ScanBox({ focus = false, onDone }: { focus?: boolean; onDone?: () => void }) {
  const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !el.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        e.preventDefault(); input.current?.focus();
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  return <form data-tour="scan" className="scanbox" onSubmit={async (e) => {
    e.preventDefault(); if (!query.trim() || busy) return; setBusy(true);
    try { const result = await fetchParsed(MOCKS ? '/scan' : `/scan?q=${encodeURIComponent(query.trim())}`, ScanResultSchema, MOCKS ? { body: { query: query.trim() } } : undefined); navigate(`/scan/${encodeURIComponent(result.id)}`); setQuery(''); onDone?.(); }
    catch (err) { useApp.getState().toast({ kind: 'error', title: 'Scan failed', body: (err as Error).message }); }
    finally { setBusy(false); }
  }}><input ref={input} autoFocus={focus} aria-label={C.search} placeholder={C.search} value={query} onChange={(e) => setQuery(e.target.value)} enterKeyHint="go" /><button type="submit" disabled={busy || !query.trim()} aria-label={C.scan}>{busy ? '…' : '↗'}</button><kbd>/</kbd></form>;
}
export function PlanChip({ compact = false }: { compact?: boolean }) {
  const config = useShell((s) => s.config), me = useShell((s) => s.me), now = useNow();
  const end = me?.trial.status === 'active' && me.trial.endsAt ? Date.parse(me.trial.endsAt) : null;
  const left = end === null ? null : Math.max(0, Math.ceil((end - now) / 1000));
  const trial = !!config?.flags.trial && left !== null;
  const tier = me?.entitlements.tier ?? 'listener';
  const label = config?.phase === 'launch_week' ? compact ? 'Free · launch week' : C.free : config?.phase === 'token_live' ? C.tokenLive : tier[0].toUpperCase() + tier.slice(1);
  return <Link className={`trial${trial ? ' trial-active' : ''}`} to="/settings/plan">
    <span className="trial-top">{trial ? <>Trial <b className="num">{Math.floor(left! / 60)}:{String(left! % 60).padStart(2, '0')}</b></> : label}</span>
    {trial && <span className="trial-bar"><i style={{ width: `${Math.min(100, left! / 1800 * 100)}%` }} /></span>}
  </Link>;
}
export function LegalLine({ pageHasAnalysis = false }: { pageHasAnalysis?: boolean }) {
  return <div className="side-legal"><p><Link to="/drops">Drops</Link> · <Link to="/settings">Settings</Link> · <Link to="/legal/terms">Legal</Link> · <Link to="/official">Official project links</Link> · <Link to="/transparency">Transparency</Link> · <Link to="/security">Security</Link></p><PolicyLinks />{!pageHasAnalysis && <><p>{BUILT_ON}</p><p>{NON_AFFILIATION}</p><p>{DYOR}</p></>}</div>;
}
function Navigation({ onDone }: { onDone?: () => void }) {
  const path = usePath(), flags = useShell((s) => s.config?.flags), approvals = useShell((s) => s.approvalIds.length);
  const ref = useRef<HTMLElement>(null); const [indicator, setIndicator] = useState<{ transform: string; height: number; opacity: number }>({ transform: '', height: 0, opacity: 0 });
  useLayoutEffect(() => {
    const place = () => {
      const item = ref.current?.querySelector<HTMLElement>('[aria-current="page"]');
      setIndicator(item ? { transform: `translateY(${item.offsetTop + item.parentElement!.offsetTop}px)`, height: item.offsetHeight, opacity: 1 } : { transform: '', height: 0, opacity: 0 });
    };
    place(); const observer = new ResizeObserver(place); if (ref.current) observer.observe(ref.current); return () => observer.disconnect();
  }, [path, flags]);
  return <nav className="side-nav" aria-label="Main" ref={ref}><i className="side-ind" style={indicator} aria-hidden="true" />{navGroups().map(([group, items], index) => <div className="side-group" key={group}><span className="side-gt"><span className="num">0{index + 1}</span> / {group}</span>
    {items.filter(([to]) => resolveRoute(to, flags)).map(([to, label, Icon]) => { return <Link data-tour={to === "/mission" ? "mission" : undefined} to={to} key={to} className="side-item" onClick={onDone} aria-current={isCurrent(to, path) ? 'page' : undefined}><Icon size={16} />{label}{to === '/mission/approvals' && approvals > 0 && <b className="side-badge" aria-label={`${approvals} waiting`}>{approvals}</b>}</Link>; })}
  </div>)}</nav>;
}
export function Sidebar() {
  const risk = useUi((s) => s.riskMode), setUi = useUi((s) => s.set), path = usePath();
  return <aside className="side"><ScanBox /><Navigation /><div className="side-foot"><PlanChip /><div data-tour="mode" className="side-risk"><span className="side-label">{C.risk}</span><Seg options={RISK_OPTIONS} value={risk} onChange={(value) => setUi({ riskMode: value as typeof risk })} label={C.risk} /></div><button className="btn" onClick={() => window.dispatchEvent(new Event('eko:open-alerts'))}>Alerts</button><WalletButton /><LegalLine pageHasAnalysis={path.startsWith('/coin/')} /></div></aside>;
}
export function Header() {
  const path = usePath(), config = useShell((s) => s.config), state = useShell((s) => s.wsState), block = useShell((s) => s.headBlock), delay = useShell((s) => s.delayedSec), now = useNow();
  const trail = breadcrumbTrail(path, config?.flags);
  const status = state === 'open' ? delay ? `Delayed ~${delay} s` : C.live : state === 'closed' ? C.offline : state === 'connecting' ? C.connecting : C.reconnecting;
  return <header className="apphdr" onClick={onHeaderBackgroundClick}><BrandLink /><nav className="apphdr-crumb" aria-label="Breadcrumb">{trail.map((label, i) => <span key={`${i}-${label}`} aria-current={i === trail.length - 1 ? 'page' : undefined}>{label}</span>)}</nav><span className="apphdr-live" data-testid="stream-status"><span className="apphdr-chain" title={CHAIN_TITLE}>{CHAIN_NAME}</span><span className="apphdr-sep" /><span className="apphdr-status"><i className={`live-dot ${state}`} />{status}</span><span className="apphdr-sep" />{C.block} <span className="num apphdr-block">{block?.toLocaleString() ?? '—'}</span><span className="apphdr-sep" /><span className="num" aria-hidden="true">{new Date(now).toISOString().slice(11, 19)} UTC</span></span></header>;
}
export function MobileBar() { return <header className="mbar" onClick={onHeaderBackgroundClick}><BrandLink /><div className="mbar-r"><PlanChip compact /><WalletButton /></div></header>; }
function Sheet({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="shell-sheet" aria-label={title} onCancel={(e) => { e.preventDefault(); close(); }}><div className="sheet-head"><h2>{title}</h2><button className="btn" onClick={close}>Close</button></div>{children}</dialog>;
}
export function MobileTabs() {
  const path = usePath(), approvals = useShell((s) => s.approvalIds.length); const [sheet, setSheet] = useState<'scan' | 'more' | null>(null);
  const close = useCallback(() => setSheet(null), []);
  useEffect(() => setSheet(null), [path]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName) && !((e.target as HTMLElement).isContentEditable) && matchMedia('(max-width: 899px)').matches) { e.preventDefault(); setSheet('scan'); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  return <><nav className="mtab" aria-label="Mobile navigation"><Link to="/radar" aria-current={isCurrent('/radar', path) ? 'page' : undefined}><IconRadar size={18} /><span>Radar</span></Link><Link to="/pairs" aria-current={isCurrent('/pairs', path) ? 'page' : undefined}><IconPairs size={18} /><span>Pairs</span></Link><button onClick={() => setSheet('scan')} aria-expanded={sheet === 'scan'}><IconSearch size={18} /><span>{C.scan}</span></button><Link to="/mission" aria-current={isCurrent('/mission', path) ? 'page' : undefined}><span className="mtab-icon"><IconAgent size={18} />{approvals > 0 && <b className="side-badge" aria-label={`${approvals} waiting`}>{approvals}</b>}</span><span>Mission</span></Link><button onClick={() => setSheet('more')} aria-expanded={sheet === 'more'}><IconMenu size={18} /><span>{C.more}</span></button></nav>
    {sheet && <Sheet title={sheet === 'scan' ? C.scan : C.more} close={close}>{sheet === 'scan' ? <ScanBox focus onDone={close} /> : <><Navigation onDone={close} /><button className="btn" onClick={() => { close(); requestAnimationFrame(() => window.dispatchEvent(new Event('eko:open-alerts'))); }}>Alerts</button><LegalLine pageHasAnalysis={path.startsWith('/coin/')} /></>}</Sheet>}
  </>;
}
