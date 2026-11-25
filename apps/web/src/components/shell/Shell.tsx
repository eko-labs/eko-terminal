import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CoinSummarySchema, type CoinSummary } from '@eko/shared';
import { z } from 'zod';
import ekoMark from '../../../../landing/src/assets/eko-mark.svg';
import '../../../../landing/src/header-brand.css';
import { BUILT_ON, DYOR, NON_AFFILIATION } from '../../copy';
import { APP_NAME, SHELL_COPY as C, RISK_OPTIONS } from '../../copy/shell';
import type { WsState } from '../../lib/ws';
import { fetchParsed, MOCKS } from '../../lib/api';
import { Link } from '../../lib/Link';
import { navigate, usePath } from '../../lib/router';
import { onHeaderBackgroundClick } from '../../lib/mainFocus';
import { isCurrent, resolveRoute } from '../../routes';
import { useApp } from '../../store/app';
import { useShell } from '../../store/shell';
import { useUi } from '../../store/ui';
import { WalletButton } from '../Header';
import { useNow } from '../hooks';
import { Seg, UntrustedText } from '../ui';
import { CompactVerdictChip } from '../GuardCompact';
import { formatAge } from '../../lib/format';
import { PolicyLinks } from '../PolicyLinks';
import { IconRadar, IconPairs, IconSearch, IconAgent, IconMenu } from '../icons';
import { navGroups, breadcrumbTrail } from './navigation';
import { TokenCa } from './TokenCa';

// A real link, not a router Link: "/" is the landing, served by the host (and by vite.config.ts in dev), not the SPA.
export function BrandLink({ compact = false }: { compact?: boolean }) {
  return <a href="/" className={`apphdr-brand eko-header-brand${compact ? ' eko-header-brand--compact' : ''}`} aria-label={`${APP_NAME}: back to the site`}><img src={ekoMark} alt="" /><span className="eko-brand-text">{APP_NAME}</span></a>;
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const SearchSchema = z.object({ rows: z.array(CoinSummarySchema) });
/**
 * The header search. A pasted contract address opens its coin page straight away (the page says if EKO does not
 * follow it). Anything else is matched against the coins EKO follows by ticker or name: one match opens it, several
 * are listed under the box to pick from (copycats share tickers, so EKO never guesses), none says so.
 */
export function ScanBox({ focus = false, onDone }: { focus?: boolean; onDone?: () => void }) {
  const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ q: string; rows: CoinSummary[] } | null>(null);
  const input = useRef<HTMLInputElement>(null), form = useRef<HTMLFormElement>(null);
  const open = (address: string) => { navigate(`/coin/${address}`); setQuery(''); setFound(null); onDone?.(); };
  useEffect(() => {
    if (!found) return;
    const away = (e: PointerEvent) => { if (!form.current?.contains(e.target as Node)) setFound(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setFound(null); input.current?.focus(); } };
    window.addEventListener('pointerdown', away); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [found]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !el.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        e.preventDefault(); input.current?.focus();
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  return <form ref={form} data-tour="scan" className="scanbox" role="search" onSubmit={async (e) => {
    e.preventDefault(); const q = query.trim(); if (!q || busy) return;
    if (ADDRESS.test(q)) { open(q); return; }
    setBusy(true);
    try {
      const { rows } = await fetchParsed(`/search?q=${encodeURIComponent(q)}`, SearchSchema);
      if (rows.length === 1) open(rows[0]!.address); else setFound({ q, rows });
    } catch (err) { useApp.getState().toast({ kind: 'error', title: 'Search failed', body: (err as Error).message }); }
    finally { setBusy(false); }
  }}><input ref={input} autoFocus={focus} aria-label={C.search} placeholder={C.search} value={query} onChange={(e) => { setQuery(e.target.value); setFound(null); }} enterKeyHint="go" autoComplete="off" spellCheck={false} /><button type="submit" disabled={busy || !query.trim()} aria-label={C.scan}>{busy ? '…' : '↗'}</button><kbd>/</kbd>
    {found && <div className="scanbox-results" role="status">{found.rows.length
      ? <><p className="scanbox-head">{found.rows.length} coins match “{found.q}”. Check the address before you trade.</p><ul>{found.rows.map(r => <li key={r.address}><button type="button" onClick={() => open(r.address)}>
          <span className="scanbox-sym">$<UntrustedText value={r.symbol} /></span><span className="scanbox-name"><UntrustedText value={r.name} /></span>
          <CompactVerdictChip level={r.verdict} pending={r.verdictPending} priceMove={r.priceMove} guard={r.guardV2} linked={false} historyPartial={r.historyPartial} />
          <span className="scanbox-meta num">{shortAddress(r.address)} · {formatAge(r.ageSec)} old</span></button></li>)}</ul></>
      : <p className="scanbox-head">No coin called “{found.q}” on EKO yet. Paste its contract address to open it.</p>}</div>}
  </form>;
}
export function PlanChip({ compact = false }: { compact?: boolean }) {
  const config = useShell((s) => s.config), me = useShell((s) => s.me), now = useNow();
  const end = me?.trial.status === 'active' && me.trial.endsAt ? Date.parse(me.trial.endsAt) : null;
  const left = end === null ? null : Math.max(0, Math.ceil((end - now) / 1000));
  const trial = !!config?.flags.trial && left !== null;
  const tier = me?.entitlements.tier ?? 'listener';
  const label = config?.phase === 'launch_week' ? compact ? 'Free · launch week' : C.free : config?.phase === 'token_live' ? C.tokenLive : tier[0].toUpperCase() + tier.slice(1);
  const card = !compact && !trial;
  return <Link className={`trial${trial ? ' trial-active' : ''}${card ? ' plan-card' : ''}`} to="/settings/plan">
    {card && <span className="plan-kick"><i className="plan-dot" aria-hidden="true" />{C.plan}</span>}
    <span className="trial-top">{trial ? <>Trial <b className="num">{Math.floor(left! / 60)}:{String(left! % 60).padStart(2, '0')}</b></> : label}</span>
    {card && <span className="plan-go" aria-hidden="true">→</span>}
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
/** One to three rising bars: how much risk a mode accepts, relative to the others. Decorative; the label names the mode. */
function RiskLevel({ level }: { level: number }) {
  return <span className="risk-level" aria-hidden="true">{[1, 2, 3].map((n) => <i key={n} className={n <= level ? 'on' : undefined} />)}</span>;
}
export function Sidebar() {
  const risk = useUi((s) => s.riskMode), setUi = useUi((s) => s.set), path = usePath();
  return <aside className="side"><ScanBox /><Navigation /><div className="side-foot"><PlanChip /><div data-tour="mode" className="side-risk"><span className="side-label">{C.risk}</span><Seg options={RISK_OPTIONS.map((o, i) => ({ value: o.value, label: <><RiskLevel level={i + 1} />{o.label}</> }))} value={risk} onChange={(value) => setUi({ riskMode: value as typeof risk })} label={C.risk} /></div><button className="btn" onClick={() => window.dispatchEvent(new Event('eko:open-alerts'))}>Alerts</button><WalletButton /><LegalLine pageHasAnalysis={path.startsWith('/coin/')} /></div></aside>;
}
/** A first connection gets this long before the header admits it is still connecting, so a normal load shows nothing. */
export const CONNECT_GRACE_MS = 5000;
/**
 * What the header's badge says, or null when the stream is healthy and the header shows only the clock. Delayed data,
 * a dropped or closed stream, and a first connection that outlasts the grace period each earn a visible badge.
 */
export function streamNotice(state: WsState, delayedSec: number, waitedMs: number): string | null {
  if (state === 'open') return delayedSec ? `Delayed ~${delayedSec} s` : null;
  if (state === 'connecting') return waitedMs < CONNECT_GRACE_MS ? null : C.connecting;
  return state === 'closed' ? C.offline : C.reconnecting;
}
export function Header() {
  const path = usePath(), config = useShell((s) => s.config), state = useShell((s) => s.wsState), delay = useShell((s) => s.delayedSec), now = useNow();
  const [mounted] = useState(() => Date.now());
  const trail = breadcrumbTrail(path, config?.flags);
  const notice = streamNotice(state, delay, Date.now() - mounted);
  // Healthy: the status stays readable to assistive tech (and to the e2e checks) but is not drawn; the clock stands alone.
  const status = notice ?? (state === 'open' ? C.live : C.connecting);
  return <header className="apphdr" onClick={onHeaderBackgroundClick}><BrandLink /><nav className="apphdr-crumb" aria-label="Breadcrumb">{trail.map((label, i) => <span key={`${i}-${label}`} aria-current={i === trail.length - 1 ? 'page' : undefined}>{label}</span>)}</nav><span className="apphdr-end"><TokenCa /><span role="status" data-testid="stream-status" data-state={state} className={notice ? `apphdr-badge${state === 'open' ? ' delayed' : ''}` : 'sr'}>{notice && <i aria-hidden="true" />}{status}</span><span className="num apphdr-clock" aria-hidden="true">{new Date(now).toISOString().slice(11, 19)} UTC</span></span></header>;
}
export function MobileBar() { return <header className="mbar" onClick={onHeaderBackgroundClick}><BrandLink compact /><div className="mbar-r"><TokenCa compact /><PlanChip compact /><WalletButton /></div></header>; }
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
