import type { CoinCard, Verdict } from '@eko/shared';
import { GlanceTile, type GlanceTone } from '../../components/GlanceTile';
import { GlanceRow } from '../../components/coinSlots';
import { exitMeasured, sellCheckNotAvailable, sellCheckOf } from '../../lib/sellCheck';
import { playbookName } from './radarModel';
import { PARTLY_CHECKED } from '../../copy/availability';
import { VerdictChip } from '../../components/ui';

/**
 * The coin page's glance row: what a trader takes in within two seconds, before the chart. The page's own tiles are the
 * verdict (order 0), whether you can sell (10) and who holds it (70); features add theirs between (features.ts glance).
 * Every tile is a label, one short value and one plain line; the detail stays in the tabs below.
 */
const LEVEL: Record<string, { word: string; tone: GlanceTone }> = {
  danger: { word: 'Danger', tone: 'bad' }, monitor: { word: 'Monitor', tone: 'watch' }, clear: { word: 'Clear', tone: 'good' },
  info: { word: 'Info', tone: 'neutral' }, pending: { word: 'Checking', tone: 'neutral' },
};

/** The verdict in a word and its strongest one or two flags, or what it found when there are none. */
export function verdictGlance(verdict: Verdict | undefined): { value: string; line: string; tone: GlanceTone } | null {
  if (!verdict) return null;
  // A Clear grade on part of the coin's history: the holder checks did not run, so it is not a plain Clear.
  if (verdict.level === 'clear' && verdict.historyPartial) return { value: PARTLY_CHECKED, line: 'Holders and early buyers not counted', tone: 'neutral' };
  const level = LEVEL[verdict.level] ?? LEVEL.pending!;
  const flags = [...verdict.playbooks].filter(p => p.level === 'danger' || p.level === 'monitor')
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'danger' ? -1 : 1)).slice(0, 2).map(p => playbookName(p.id, p.level));
  const line = flags.length ? flags.join(' · ') : verdict.level === 'clear' ? 'No red flags found' : verdict.level === 'pending' ? 'Checks still running' : 'Nothing serious found';
  return { value: level.word, line, tone: level.tone };
}

/** Can you get out: the sell check's answer, and what buying $1K and selling it straight back loses (its round trip). */
export function sellGlance(card: CoinCard | undefined): { value: string; line: string; tone: GlanceTone; gauge?: number } | null {
  if (!card) return null;
  const t = card.tradeability, sell = sellCheckOf(card);
  if (t.honeypot || sell === 'refused') return { value: 'No', line: 'A sell failed in simulation', tone: 'bad' };
  if (sellCheckNotAvailable(card)) return { value: 'Not checked', line: 'No sell check for this pool yet', tone: 'neutral' };
  if (!exitMeasured(card, 'usd1k')) return { value: 'Not checked', line: 'Sell check has not run yet', tone: 'neutral' };
  const cost = Math.round(t.exitCostPct.usd1k * 10) / 10;
  // It sells, but a costly exit is not a plain yes.
  if (cost > 30) return { value: 'Costly', line: `A $1K round trip loses ${cost}%`, tone: 'bad', gauge: cost };
  return { value: 'Yes', line: `A $1K round trip costs ${cost}%`, tone: cost > 10 ? 'watch' : 'good', gauge: cost };
}

/** Who holds it: the top ten's share, with the dev's and the bundles' beside it. */
export function holdersGlance(card: CoinCard | undefined): { value: string; line: string; tone: GlanceTone; gauge?: number } | null {
  if (!card || card.meta?.supply?.unavailable) return null;
  if (card.meta?.supply?.missing?.includes('top10Pct')) return { value: 'Not checked', line: card.meta.supply.flags?.includes('history_partial') ? 'EKO started following it after launch' : 'Holders not counted yet', tone: 'neutral' };
  const s = card.supply, bundles = card.meta?.supply?.missing?.includes('bundlesHeldPct') ? null : s.bundlesHeldPct;
  const line = [`Dev ${s.devPct}%`, ...(bundles !== null ? [`bundles ${bundles}%`] : [])].join(' · ');
  return { value: `${Math.round(s.top10Pct)}%`, line, tone: s.top10Pct > 50 ? 'bad' : s.top10Pct > 25 ? 'watch' : 'good', gauge: s.top10Pct };
}

export function CoinGlance({ card, verdict, guard, onVerdict }: { card: CoinCard | null | undefined; verdict: Verdict | null | undefined; guard?: unknown; onVerdict: () => void }) {
  card = card ?? undefined; verdict = verdict ?? undefined;
  const v = verdictGlance(verdict), sell = sellGlance(card), holders = holdersGlance(card);
  const loading = !card && !verdict && !guard;
  return <GlanceRow tone={v?.tone ?? 'neutral'} own={[
    { order: 0, node: <button type="button" data-tour="verdict" className="glance-verdict-hit" onClick={onVerdict} aria-describedby="glance-verdict-hint">
      {/* The verdict in the site's own chip, made large, with its strongest flags after it. */}
      <span className="gv"><span className="gv-label">EKO says</span>
        <VerdictChip level={verdict?.level ?? 'pending'} size="lg" showGaps={false} {...(verdict?.historyPartial ? { historyPartial: verdict.historyPartial } : {})} />
        <span className="gv-flags">{v?.line ?? 'Checks still running'}</span></span><span id="glance-verdict-hint" className="sr-only">Opens the evidence</span></button> },
    { order: 10, node: <GlanceTile label="Can you sell?" value={sell?.value ?? 'Not checked'} line={sell?.line} tone={sell?.tone ?? 'neutral'} loading={loading} {...(sell?.gauge !== undefined ? { gauge: sell.gauge } : {})}
      target={{ tab: 'Overview', section: 'coin-tradeability' }} /> },
    ...(holders || loading ? [{ order: 70, node: <GlanceTile label="Top 10 hold" value={holders?.value ?? ''} line={holders?.line} tone={holders?.tone ?? 'neutral'} loading={loading} {...(holders?.gauge !== undefined ? { gauge: holders.gauge } : {})}
      target={{ tab: 'Overview', section: 'coin-supply' }} /> }] : []),
  ]} />;
}
