import { ratingPriceFact, type RatingPriceMove, compactGuardVerdict, type GuardConsumerRequest, type GuardAssessmentV2, type Verdict } from '@eko/shared';
import { VerdictChip } from './ui';
import { AnalysisPolicyNotice } from './PolicyLinks';
import { Link } from '../lib/Link';
import { GUARD_REFRESH_FAILED, GUARD_COPY } from '../copy/guard';
import { GUARD_LEGEND, LEGACY_TITLE } from '../copy/availability';

/** Lists can show a shadow alongside the original grade without replacing it. */
export function CompactVerdictChip({ priceMove, level, guard, pending = false, failed = false, linked = true, ...context }: { priceMove?: RatingPriceMove; level: Verdict['level'] | 'info'; guard?: GuardAssessmentV2 | null; pending?: boolean; failed?: boolean; linked?: boolean; evaluatedPlaybooks?: import('@eko/shared').PlaybookId[]; missing?: string[]; scanDelayed?: boolean; detail?: string; detailTitle?: string }) {
  const fact=<RatingPriceFact move={priceMove}/>;
  const snapshot = guard ? compactGuardVerdict({version:2,assessment:guard}) : null;
  const detailText = guard && `Block ${guard.cursor.blockNumber} · $100 / $1,000 · EOA / smart account`;
  const details = snapshot && (linked ? <Link to={snapshot.evidencePath!} title={snapshot.snapshot}>{detailText} · {GUARD_COPY.allReasons}</Link> : <span title={snapshot.snapshot}>{detailText}</span>);
  if (guard?.mode === 'active') return <>{fact}<VerdictChip level={level} guard={guard} />{details}{failed && <span>{GUARD_REFRESH_FAILED}</span>}</>;
  // No Guard 2 result: the row shows the grade alone. Guard 2 has no release, so every row carried a "Legacy grade" tag
  // beside the only grade there is; the list's legend (GuardLegend) says once which rule set graded the rows.
  if (guard === null) return <>{fact}{failed && <span>{GUARD_REFRESH_FAILED}</span>}<VerdictChip level={level} verdictPending={pending} {...context} /></>;
  return <>{fact}{failed && <span>{GUARD_REFRESH_FAILED}</span>}{guard !== undefined && <span className="tag" title={LEGACY_TITLE}>Rule set 1.0.x</span>}<VerdictChip level={level} verdictPending={pending} {...context} />
    {guard ? <VerdictChip level={level} guard={guard} /> : null}{details}</>;
}
/** Lists that show the rule set 1.0.x grade beside a missing or shadow Guard 2 result explain both labels once, above the rows. */
export function GuardLegend({ rows }: { rows: { guardV2?: GuardAssessmentV2 | null }[] }) {
  return rows.some((row) => row.guardV2 !== undefined && row.guardV2?.mode !== 'active') ? <p className="availability-legend guard-legend">{GUARD_LEGEND}</p> : null;
}
/** Three summary lines; full findings stay accessible on the detail surface. */
export function GuardCompact({ verdict }: { verdict: GuardConsumerRequest }) {
  const view = compactGuardVerdict(verdict);
  return <section className="guard-compact">
    <strong>{view.label}</strong>{view.mode && <p>{view.mode}</p>}{view.gap && <strong className="guard-gap">{view.gap}</strong>}
    <p>{view.snapshot}</p><ul>{view.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
    {view.evidencePath && <Link to={view.evidencePath}>{GUARD_COPY.allReasons}</Link>}
    <AnalysisPolicyNotice />
  </section>;
}

/** A price fact never changes the risk label. */
export function RatingPriceFact({move}:{move?:RatingPriceMove}) {
  const fact=ratingPriceFact(move);
  return fact ? <span className="muted rating-price-fact">{fact}</span> : null;
}
