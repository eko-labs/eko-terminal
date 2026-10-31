import { GhostReports } from '../../components/GhostReports';
import { CompactVerdictChip } from '../../components/GuardCompact';
import { AnalysisPolicyNotice } from '../../components/PolicyLinks';
import { FEED_GAPS_LEGEND } from '../../copy/availability';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { CoinCardSchema, NegotiatedGuardVerdictSchema, WatchBodySchema, type GuardAssessmentV2, type CoinCard, type FeedItem, type WalletLabel } from '@eko/shared';
import { UntrustedText, UnavailableValue, WALLET_LABEL_WORD } from '../../components/ui';
import { IconAgent, IconAlert, IconArrow, IconBell, IconChevron, IconShield, IconWallet } from '../../components/icons';
import { fetchParsed, isRateLimited, MOCKS } from '../../lib/api';
import { Link } from '../../lib/Link';
import { useRealtime } from '../../lib/RealtimeContext';
import { useMedia } from '../../lib/useMedia';
import { useShell } from '../../store/shell';
import { FlowBar } from './RadarParts';
import { formatFeedSize } from '../../lib/format';
import { feedDescriptionParts, feedGroup, feedRing, FEED_GROUPS, FEED_RING, FeedResponseSchema, flushFeed, receiveFeed, type FeedBuffer, type FeedGroup } from './pairsFeedModel';
import { useTerminalWindow } from './terminalWindow';
import './radar.css';
import './secondary.css';

const KINDS = {
  trade: { label: 'Trades', one: 'Trade', Icon: IconWallet }, scan: { label: 'Fast Scans', one: 'Fast Scan', Icon: IconShield },
  alert: { label: 'Playbook alerts', one: 'Playbook alert', Icon: IconBell }, ghost: { label: 'Ghost Reports', one: 'Ghost Report', Icon: IconAlert },
  swarm: { label: 'Swarm calls', one: 'Swarm call', Icon: IconAgent }, launch: { label: 'Launches', one: 'Launch', Icon: IconArrow }, burn: { label: 'Burns', one: 'Burn', Icon: IconBell },
};
export function LabelGlyph({ label }: { label: WalletLabel }) {
  return <svg className={`label-glyph ${label}`} viewBox="0 0 10 10" role="img" aria-label={WALLET_LABEL_WORD[label]}>
    {label === 'declared_agent' ? <><rect x="1" y="2" width="8" height="7" rx="1.2" /><path d="M5 0v2" /></> : label === 'likely_agent' ? <rect x="1.5" y="2.5" width="7" height="6" rx="1.2" fill="none" /> : label === 'crew' ? <><circle cx="3.4" cy="5" r="2.4" fill="none" /><circle cx="6.6" cy="5" r="2.4" fill="none" /></> : <><circle cx="5" cy="2.5" r="1.5" /><path d="M2.5 9V7a2.5 2.5 0 015 0v2" fill="none" /></>}
  </svg>;
}
export function FeedDescription({ item }: { item: FeedItem }) {
  return <>{feedDescriptionParts(item).map((part, i) => <span key={i} className={`fr-part${part.style ? ` fr-part-${part.style}` : ''}`}>{i > 0 && ' '}{part.style === 'label' && item.label && <LabelGlyph label={item.label} />}{'text' in part ? part.text : <>{part.prefix}<UntrustedText value={part.value} /></>}</span>)}</>;
}
/** Coins without an indexed symbol show their short address instead of a bare "$". */
export function FeedSymbol({ item }: { item: Pick<FeedItem, 'coin' | 'symbol'> }) {
  return item.symbol.text.trim() ? <>$<UntrustedText value={item.symbol} /></> : <span className="addr">{item.coin.slice(0, 6)}…{item.coin.slice(-4)}</span>;
}
// The header clock and the coin view's trades are in UTC, so Feed times are too.
export const feedTime = (ts: number) => new Date(ts).toISOString().slice(11, 19);
export function FeedRow({ item }: { item: FeedItem }) {
  const group = feedGroup(item.kind), kind = KINDS[group];
  const to = `/coin/${item.coin}`;
  return <li className={`frow k-${group}`} data-feed-id={item.id}>
    <time className="fr-time num" dateTime={new Date(item.ts).toISOString()}>{feedTime(item.ts)}</time>
    <span className="fr-kind" title={kind.one}><kind.Icon /><span className="sr">{kind.one}</span></span>
    <Link to={to} className="fr-sym" title={item.symbol.text.trim() ? `$${item.symbol.text}` : item.coin}><FeedSymbol item={item} /></Link>
    <span className="fr-desc"><span className="fr-clip"><FeedDescription item={item} /></span></span>
    <span className="fr-end">{group === 'trade' && item.sizeUsd !== undefined ? <span className="num fr-size">{formatFeedSize(item.sizeUsd)}</span> : group === 'ghost' ? <Link to={to} className="fr-evidence">Evidence<IconChevron /></Link> : group === 'swarm' ? <span className="tag beta">Beta</span> : item.guardV2 || item.level ? <CompactVerdictChip priceMove={item.priceMove} level={item.level ?? 'pending'} guard={item.guardV2} /> : null}</span>
  </li>;
}
const countsOf = (rows: FeedItem[]) => Object.fromEntries(FEED_GROUPS.map((k) => [k, rows.filter((r) => feedGroup(r.kind) === k).length])) as Record<FeedGroup, number>;
export default function Feed() {
  const rt = useRealtime(), mobile = useMedia('(max-width:700px)'), ws = useShell((s) => s.wsState);
  const [buffer, setBuffer] = useState<FeedBuffer>({ items: [], waiting: [] });
  const [kinds, setKinds] = useState<FeedGroup[]>([...FEED_GROUPS]), [watchOnly, setWatchOnly] = useState(false), [watched, setWatched] = useState<string[]>([]);
  const [hover, setHover] = useState(false), [focus, setFocus] = useState(false), [scrolled, setScrolled] = useState(false);
  const [unavailable,setUnavailable]=useState<string[]>(MOCKS ? [] : ['agent_trade','crew_trade','clone','swarm','burn']);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [watchError, setWatchError] = useState(false), [delayed, setDelayed] = useState(0);
  const [now, setNow] = useState(Date.now()), [seen, setSeen] = useState(Date.now()), [cards, setCards] = useState<Record<string, CoinCard>>({});
  const [guards, setGuards] = useState<Record<string, GuardAssessmentV2 | null>>({});
  const list = useRef<HTMLElement>(null), rowsRef = useRef<HTMLDivElement>(null), initialized = useRef(false), snapshotEvents = useRef<FeedItem[] | null>(null);
  const generation = useRef(0);
  const paused = hover || focus || scrolled, pausedRef = useRef(paused); pausedRef.current = paused;
  const kindsRef = useRef(kinds); kindsRef.current = kinds;
  const keep = (item: FeedItem) => kinds.includes(feedGroup(item.kind)) && (!watchOnly || watched.includes(item.coin));
  const shown = buffer.items.filter(keep), queued = buffer.waiting.filter(keep).length, range = useTerminalWindow(rowsRef, shown.length, mobile ? 66 : 42);
  const snapshot = useCallback(async (signal?: AbortSignal) => {
    const request = ++generation.current;
    snapshotEvents.current = []; setError(null);
    try {
      const selected = FeedItemKinds(kindsRef.current);
      if (!selected.length) { snapshotEvents.current = null; return; }
      let cursor: string | null = null, rows: FeedItem[] = [], delay = 0;
      const visited = new Set<string>();
      let pages = 0;
      do {
        const data: z.infer<typeof FeedResponseSchema> = await fetchParsed(`${MOCKS ? '' : '/v2'}/feed?kinds=${selected.join(',')}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, FeedResponseSchema, { signal });
        if(!signal?.aborted && request===generation.current && data.unavailable)setUnavailable(data.unavailable);
        rows.push(...data.rows);
        if(rows.length<=100 && !initialized.current && !signal?.aborted && request===generation.current){setBuffer({items:feedRing([...(snapshotEvents.current ?? []),...rows]),waiting:[]});setLoading(false);}
        delay = data.delayedSec; cursor = data.cursor;
        if (cursor && visited.has(cursor)) break;
        if (cursor) visited.add(cursor);
      } while (cursor && rows.length < FEED_RING && ++pages < 10);
      if (signal?.aborted || request !== generation.current) return;
      const next = feedRing([...(snapshotEvents.current ?? []), ...rows]); snapshotEvents.current = null;
      const hold = initialized.current && pausedRef.current;
      setBuffer((old) => hold ? receiveFeed(old, next, true) : { items: next, waiting: [] });
      initialized.current = true; setDelayed(delay); setSeen(Date.now());
    } catch (e) { if ((e as Error).name !== 'AbortError' && !isRateLimited(e)) { if (request === generation.current) setError((e as Error).message); throw e; } }
    finally { if (request === generation.current) { snapshotEvents.current = null; if (!signal?.aborted) setLoading(false); } }
  }, []);
  useEffect(() => { const ac = new AbortController(); void snapshot(ac.signal).catch(() => {}); return () => ac.abort(); }, [snapshot, kinds]);
  useEffect(() => rt?.subscribeBatch('feed', (events) => { const rows = events.map((e) => e.data); if (snapshotEvents.current) snapshotEvents.current = feedRing([...rows, ...snapshotEvents.current]); setBuffer((old) => receiveFeed(old, rows, pausedRef.current)); setSeen(Date.now()); }, () => snapshot()), [rt, snapshot]);
  useEffect(() => { if (!paused) setBuffer(flushFeed); }, [paused]);
  useEffect(() => {
    const on = () => setScrolled((list.current?.getBoundingClientRect().top ?? 1000) < 78);
    window.addEventListener('scroll', on, { passive: true }); on(); return () => window.removeEventListener('scroll', on);
  }, []);
  useEffect(() => { const t = setInterval(() => { if (!pausedRef.current) setNow(Date.now()); }, 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!watchOnly) return;
    const ac = new AbortController(); setWatchError(false);
    void fetchParsed('/watch', z.object({ items: z.array(WatchBodySchema) }), { signal: ac.signal }).then((data) => setWatched(data.items.filter((w) => w.kind === 'coin').map((w) => w.target))).catch((e) => { if (e.name !== 'AbortError' && !isRateLimited(e)) setWatchError(true); });
    return () => ac.abort();
  }, [watchOnly]);
  const tracked=(k:FeedGroup)=>FeedItemKinds([k]).some(kind=>!unavailable.includes(kind));
  const count=(k:FeedGroup,n:number)=>tracked(k) ? n : <UnavailableValue tracked />;
  const lastMinute = buffer.items.filter((e) => now - e.ts < 60000).length;
  const counts = useMemo(() => countsOf(buffer.items), [buffer.items]);
  const recent = useMemo(() => countsOf(buffer.items.filter((e) => now - e.ts < 300000)), [buffer.items, now]);
  const busiest = useMemo(() => { const byCoin = new Map<string, { item: FeedItem; n: number }>(); buffer.items.forEach((item) => { const old = byCoin.get(item.coin); byCoin.set(item.coin, { item, n: (old?.n ?? 0) + 1 }); }); return [...byCoin.values()].sort((a, b) => b.n - a.n).slice(0, 6); }, [buffer.items]);
  const busyKey = busiest.map((b) => b.item.coin).sort().join(',');
  useEffect(() => {
    const ac = new AbortController();
    void Promise.allSettled(busyKey.split(',').filter(Boolean).map(async (address) => { const card = await fetchParsed(`/coins/${address}`, CoinCardSchema, { signal: ac.signal }); return [address, card] as const; })).then((results) => { if (!ac.signal.aborted) setCards(old => ({ ...old, ...Object.fromEntries(results.flatMap((r) => r.status === 'fulfilled' ? [r.value] : [])) })); });
    if (!MOCKS) void Promise.allSettled(busyKey.split(',').filter(Boolean).map(async address => {
      const result = await fetchParsed(`/v2/coins/${address}/verdict`, NegotiatedGuardVerdictSchema, {signal:ac.signal});
      if (result.version !== 2) throw new Error('Guard schema negotiation failed');
      return [address, result.verdict] as const;
    })).then(results => { if (!ac.signal.aborted) setGuards(old => ({...old,...Object.fromEntries(results.flatMap(r => r.status === 'fulfilled' ? [[r.value[0],r.value[1] ?? old[r.value[0]] ?? null]] : []))})); });
    return () => ac.abort();
  }, [busyKey]);
  const maxRecent = Math.max(1, ...Object.values(recent)), height = mobile ? 66 : 42;
  const flush = () => { setBuffer(flushFeed); list.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const stale = ws !== 'open' || Date.now() - seen > 90000;
  // TODO(spec): CA-2 has no daily Ghost Report count. Show the count in the available ring instead of inventing a daily total.
  return <div className="page sec-page feed-page"><div className="page-head"><div><h1>Feed</h1><p>Trades, Fast Scans, playbook alerts and Ghost Reports across Elysium, as they happen.</p></div><div className="stats-inline"><span><b className="num">{lastMinute}</b> {lastMinute === 1 ? 'event' : 'events'} in the last minute</span><span><b className="num">{count('ghost',counts.ghost)}</b> Ghost Reports in the Feed</span></div></div>
    {!MOCKS && <p className="availability-legend">{FEED_GAPS_LEGEND}</p>}<div className="toolbar feed-toolbar"><div className="feed-filters"><span className="muted">Show</span>{FEED_GROUPS.map((k) => <label key={k} className="check feed-kind"><input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds((old) => e.target.checked ? [...old, k] : old.filter((v) => v !== k))} /><i aria-hidden="true" />{KINDS[k].label}<span className="num muted">{count(k,counts[k])}</span>{k === 'swarm' && <span className="tag beta">Beta</span>}</label>)}<span className="feed-rule" aria-hidden="true" /><label className="check feed-kind"><input type="checkbox" checked={watchOnly} onChange={(e) => setWatchOnly(e.target.checked)} /><i aria-hidden="true" />Watched coins only</label></div><span className="toolbar-live" role="status"><span className={`sb-dot${paused || stale ? ' stale' : ''}`} /><span className="live-slot"><span>{paused ? <>Paused<span className="sr"> while you read</span></> : delayed ? `Delayed ~${delayed} s` : stale ? ws === 'reconnecting' ? 'Reconnecting' : 'Stale' : 'Live'}</span></span></span></div>
    {error && <div className="radar-error" role="alert">{error} <button className="btn" onClick={() => void snapshot().catch(() => {})}>Retry</button></div>}{watchError && <p role="status">Could not load watched coins. <button className="btn" onClick={() => setWatchOnly(false)}>Show all coins</button></p>}
    {kinds.includes('ghost') && <GhostReports coins={watchOnly ? watched : undefined} />}
    <div className="feed-grid"><section className="panel feed-list" ref={list} aria-label="Live feed" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onFocus={() => setFocus(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocus(false); }}>
      {queued > 0 && <div className="feed-pill-wrap"><button className="btn btn-sm btn-primary feed-pill" onClick={flush}><IconArrow style={{ transform: 'rotate(-90deg)' }} />{queued} new</button></div>}
      <div className="frow frow-head" aria-hidden="true"><span>Time (UTC)</span><span /><span>Coin</span><span>What happened</span><span className="fr-end">Size or verdict</span></div>
      {loading ? <div className="skel" style={{ height: 420 }} aria-label="Loading feed" /> : shown.length ? <div ref={rowsRef}><ul><li aria-hidden="true" style={{ height: range.start * height }} />{shown.slice(range.start, range.end).map((item) => <FeedRow key={item.id} item={item} />)}<li aria-hidden="true" style={{ height: (shown.length - range.end) * height }} /></ul></div> : <div className="empty">{!kinds.length ? 'Pick at least one kind of event to show.' : watchOnly ? 'Nothing from your watched coins yet. New events land here as they happen.' : 'Quiet right now. New events land here as they happen.'}</div>}
      {shown.length >= 40 && <p className="feed-foot">The Feed keeps the latest {FEED_RING} events. Older trades are on each coin’s Trades tab.</p>}
    </section><aside className="feed-aside"><section className="panel"><div className="panel-head"><h3>Last 5 minutes</h3><span className="muted num">{Object.values(recent).reduce((a, b) => a + b, 0)} events</span></div><div className="panel-body"><ul className="feed-mix">{FEED_GROUPS.map((k) => { const K = KINDS[k]; return <li key={k} className={`k-${k}`}><span className="fr-kind"><K.Icon /></span><span>{K.label}</span><div className="bar"><i style={{ width: `${tracked(k) ? recent[k] / maxRecent * 100 : 0}%` }} /></div><b className="num">{count(k,recent[k])}</b></li>; })}</ul></div></section>
      <section className="panel"><div className="panel-head"><h3>Busiest coins</h3><span className="muted">In the Feed now</span></div><div className="panel-body"><ul className="feed-busy">{busiest.map(({ item, n }) => { const card = cards[item.coin]; return <li key={item.coin}><div className="fb-top"><Link to={`/coin/${item.coin}`} className="fr-sym" title={item.symbol.text.trim() ? `$${item.symbol.text}` : item.coin}><FeedSymbol item={item} /></Link><span className="muted num">{n} events</span>{card && <CompactVerdictChip priceMove={card.verdict.priceMove} level={card.verdict.level} guard={MOCKS ? undefined : guards[item.coin]} />}</div>{card && <div className="fb-flow"><span className="muted">Agents <b className="num">{card.meta?.flow?.unavailable ? <UnavailableValue /> : `${Math.round(card.flow.agentPct)}%`}</b>{card.flow.beta && <span className="tag beta">Beta</span>}</span><FlowBar flow={card.flow} unavailable={card.meta?.flow?.unavailable} compact /></div>}</li>; })}</ul></div></section>
      <p className="note feed-note">Each line is written from structured on-chain fields. Token names are sanitised; token descriptions never appear here. Wallet labels and swarm calls are Beta. Not financial advice.</p>
    </aside></div><AnalysisPolicyNotice />
  </div>;
}
function FeedItemKinds(groups: readonly FeedGroup[]): FeedItem['kind'][] {
  return (['new_pair', 'trade', 'agent_trade', 'crew_trade', 'verdict', 'playbook', 'swarm', 'clone', 'wash', 'graduation', 'burn'] as const).filter((kind) => groups.includes(feedGroup(kind)));
}
