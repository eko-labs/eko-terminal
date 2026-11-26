import { useEffect, useRef, useState, type ComponentType } from 'react';
import { z } from 'zod';
import { CoinSummarySchema, type CoinSummary } from '@eko/shared';
import { IconAlert, IconCheck, IconEye, IconInfo, IconOct, IconSearch } from '../../components/icons';
import { UntrustedText } from '../../components/ui';
import { fetchParsed } from '../../lib/api';
import { navigate } from '../../lib/router';
import { answerOf, type Answer, type AnswerKind, type Reason, type Tone } from './model';
import { Decode } from '../../pages/terminal/radarMotion';
import type { Untrusted } from '@eko/shared';

/** A coin's ticker; a coin that has no name yet (seconds after launch) shows its short address, never a lone "$". */
export function Ticker({ symbol, address }: { symbol: Untrusted; address: string }) {
  if (!symbol.text.trim()) return <span className="sv-noname" title={address}>{`${address.slice(0, 6)}…${address.slice(-4)}`}</span>;
  return <Decode text={`$${symbol.text}`}><span>$<UntrustedText value={symbol} /></span></Decode>;
}

const ICONS: Record<AnswerKind, ComponentType<{ size?: number }>> = { ok: IconCheck, careful: IconAlert, dont: IconOct, checking: IconEye };
/** The site's verdict chip classes (styles/ui.css .verdict), so the answer wears the same plate as Full's. */
const CHIP: Record<AnswerKind, string> = { ok: 'clear', careful: 'monitor', dont: 'danger', checking: 'pending' };

/** The answer as the site's verdict chip, in plain words: `lg` on the coin page, as Full's glance band draws it. */
export function AnswerChip({ answer, size, walk }: { answer: Answer; size?: 'lg' | 'md'; walk?: string }) {
  const Icon = ICONS[answer.kind];
  return <span className={`verdict ${CHIP[answer.kind]} sv-chip${size ? ` sv-chip-${size}` : ''}`} data-walk={walk}><Icon />{answer.word}</span>;
}

const REASON_ICONS: Record<Tone, ComponentType<{ size?: number }>> = { good: IconCheck, watch: IconAlert, bad: IconOct, neutral: IconInfo };
/** Up to three plain reasons, each with its small icon, the strongest first. */
export function Reasons({ reasons }: { reasons: Reason[] }) {
  return <ul className="sv-reasons">{reasons.map(r => { const Icon = REASON_ICONS[r.tone]; return <li key={r.text} className={`sv-reason sv-reason-${r.tone}`}><Icon size={16} /><span>{r.text}</span></li>; })}</ul>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SearchSchema = z.object({ rows: z.array(CoinSummarySchema) });
/**
 * The big search box, with the header search's rules (components/shell/Shell.tsx ScanBox): a pasted address opens that
 * coin; a name or ticker opens its coin when one matches, lists them when several do (copycats share names), and says
 * so when none does.
 */
export function CoinSearch() {
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ q: string; rows: CoinSummary[] } | null>(null), [failed, setFailed] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const open = (address: string) => { setQuery(''); setFound(null); navigate(`/coin/${address}`); };
  useEffect(() => {
    if (!found) return;
    const away = (e: PointerEvent) => { if (!form.current?.contains(e.target as Node)) setFound(null); };
    window.addEventListener('pointerdown', away); return () => window.removeEventListener('pointerdown', away);
  }, [found]);
  return <form ref={form} className="sv-search" role="search" onSubmit={async (e) => {
    e.preventDefault(); const q = query.trim(); if (!q || busy) return;
    if (ADDRESS.test(q)) { open(q); return; }
    setBusy(true); setFailed(false);
    try {
      const { rows } = await fetchParsed(`/search?q=${encodeURIComponent(q)}`, SearchSchema);
      if (rows.length === 1) open(rows[0]!.address); else setFound({ q, rows });
    } catch { setFailed(true); } finally { setBusy(false); }
  }}>
    <label className="sv-search-box">
      <IconSearch size={22} />
      <span className="sr-only">Paste a coin address to check it</span>
      <input value={query} onChange={e => { setQuery(e.target.value); setFound(null); setFailed(false); }} placeholder="Paste a coin address to check it" autoComplete="off" spellCheck={false} enterKeyHint="go" />
      <button type="submit" className="sv-btn sv-btn-small" disabled={busy || !query.trim()}>{busy ? 'Checking…' : 'Check'}</button>
    </label>
    {failed && <p className="sv-search-note" role="status">EKO couldn't search just now. Try again in a moment.</p>}
    {found && <div className="sv-search-found" role="status">{found.rows.length
      ? <><p className="sv-search-note">{found.rows.length} coins are called “{found.q}”. Copycats use the same names, so pick carefully.</p>
        <ul>{found.rows.map(r => <li key={r.address}><button type="button" onClick={() => open(r.address)}>
          <span className="sv-found-id"><b>$<UntrustedText value={r.symbol} /></b><span><UntrustedText value={r.name} /></span></span>
          <AnswerChip answer={answerOf({ level: r.verdict, pending: r.verdictPending, historyPartial: r.historyPartial, guard: r.guardV2 })} />
        </button></li>)}</ul></>
      : <p className="sv-search-note">EKO doesn't know a coin called “{found.q}” yet. Paste its address instead.</p>}</div>}
  </form>;
}
