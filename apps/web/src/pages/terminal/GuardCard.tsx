import { type ReactNode } from 'react';
import { type CoinCardV2, type GuardAssessmentV2, type GuardCoverage, type Metric, type Untrusted } from '@eko/shared';
import { AnalysisPolicyNotice } from '../../components/PolicyLinks';
import { Seg, UntrustedText, VerdictChip, inertText } from '../../components/ui';
import { GUARD2_UNAVAILABLE_TITLE } from '../../copy/availability';
import { GUARD_EMPTY, GUARD_NO_RECORDS, GUARD_PENDING, GUARD_COPY as C, GUARD_POLICY_OPTIONS, GUARD_METRIC_NAMES, GUARD_GROUPS, GUARD_QUOTE_HEADINGS, guardBuyText, guardName, guardCoverageText, guardMeasurementText, guardRawAmount, guardSnapshotText, guardLegacyText, GUARD_DETAIL_COPY as D, guardNotRunText, guardSectionCounts, guardFineSectionText, formatGuardReason, GUARD_CHECK_LABELS, GUARD_CHECK_STATUS } from '../../copy/guard';
import { useNow } from '../../components/hooks';
import { NOT_CHECKED } from '../../copy/availability';
import { API_BASE } from '../../lib/api';
import { Link } from '../../lib/Link';
import { useUi } from '../../store/ui';
import { Spark } from '../../components/ui/charts';
import { guardDetailModel, type GuardDetailRow } from './guardDetailModel';
/** Rating checks and scored factors are what a buyer calls a check. Every other row is one measurement. */
const isCheckRow = (row: { id: string }) => /^(factor|check)\./.test(row.id);

const label = (key: string) => GUARD_METRIC_NAMES[key] ?? guardName(key);
function evidenceUrl(coin: string, id: string) {
  return `${API_BASE.replace(/\/v1$/, '')}/v2/coins/${encodeURIComponent(coin)}/evidence/${encodeURIComponent(id)}`;
}
function EvidenceLinks({ coin, ids }: { coin: string; ids: string[] }) {
  return <>{ids.map((id, i) => <a key={id} href={evidenceUrl(coin, id)}>{C.evidence} {i + 1} · {id.slice(0, 10)} </a>)}</>;
}
function Coverage({ value }: { value: GuardCoverage }) {
  return <span className="guard-coverage">{guardCoverageText(value)}</span>;
}
function CardDetails({ title, children }: { title: string; children: ReactNode }) {
  return <details className="panel guard-section"><summary className="panel-head">{title}</summary><div className="panel-body">{children}</div></details>;
}
function MetricView({ metric, coin, card }: { metric: Metric<unknown>; coin: string; card?: CoinCardV2 }) {
  const known = metric.status !== 'unknown' && metric.status !== 'not_applicable';
  const scalar = metric.value === null || typeof metric.value !== 'object';
  let value: ReactNode = metric.status === 'not_applicable' ? C.notApplicable : NOT_CHECKED;
  if (known && scalar) {
    const text = typeof metric.value === 'boolean' ? metric.value ? C.yes : C.no : String(metric.value);
    value = `${metric.unit === 'usd' ? '$' : ''}${guardName(text)}${metric.unit === 'pct' ? '%' : metric.unit === 'seconds' ? ' s' : ''}`;
  } else if (known) value = <Fields value={metric.value} coin={coin} card={card} />;
  return <div className="guard-metric" data-status={metric.status}>
    <div>{value} <span className="tag">{guardName(metric.status)}</span>{metric.failureCode && <span> · {guardName(metric.failureCode)}</span>}</div>
    <Coverage value={metric.coverage} />
    <details className="ev"><summary>{C.measurement}</summary>
      {guardMeasurementText(metric).map(line => <p key={line}>{line}</p>)}
      <EvidenceLinks coin={coin} ids={metric.evidenceIds} />
    </details>
  </div>;
}
// Walk only the closed CoinCardV2 contract after runtime parsing. Untrusted text,
// metrics and coverage have dedicated boundaries; no HTML/Markdown/linkification.
function Fields({ value, coin, card, field = '' }: { value: unknown; coin: string; card?: CoinCardV2; field?: string }) {
  if (value === null) return <span>{NOT_CHECKED}</span>;
  if (Array.isArray(value)) {
    const key = field === 'fields' ? 'textFields' : field;
    const coverage = card?.collectionCoverage?.[key as keyof NonNullable<CoinCardV2['collectionCoverage']>];
    if (!value.length) return <div>{coverage?.complete ? GUARD_NO_RECORDS : GUARD_EMPTY}{coverage && <Coverage value={coverage} />}</div>;
    return <div className="guard-records">{coverage && <Coverage value={coverage} />}{value.map((v, i) => <div className="guard-record" key={i}><Fields value={v} coin={coin} card={card} /></div>)}</div>;
  }
  if (typeof value !== 'object') return <span>{typeof value === 'boolean' ? value ? C.yes : C.no : String(value)}</span>;
  if ('text' in value && 'flags' in value) {
    const text = value as Untrusted;
    return <><UntrustedText value={text} /><button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(inertText(text.text))}>{C.copyText}</button></>;
  }
  if ('unit' in value && 'knownAt' in value && 'status' in value) return <MetricView metric={value as Metric<unknown>} coin={coin} card={card} />;
  if ('scopeId' in value && 'complete' in value) return <Coverage value={value as GuardCoverage} />;
  if ('raw' in value && 'decimals' in value && 'asset' in value) return <span className="num">{guardRawAmount(value as { raw: string; decimals: number; asset: string })}</span>;
  return <dl className="kv guard-fields">{Object.entries(value).map(([key, v]) => <div key={key}><dt>{label(key)}</dt><dd><Fields value={v} coin={coin} card={card} field={key} /></dd></div>)}</dl>;
}
export function GuardPolicyControls({ guard, mode, onChange }: { guard: GuardAssessmentV2; mode: 'safe' | 'balanced' | 'degen'; onChange: (mode: 'safe' | 'balanced' | 'degen') => void }) {
  return <><Seg options={GUARD_POLICY_OPTIONS} value={mode} onChange={v => onChange(v as typeof mode)} label={C.mode} />
    <p role="status">{guardBuyText(guard, mode)}</p><p>{C.sellState}</p></>;
}
function DetailRow({ row, coin, card, finding = false }: { row: GuardDetailRow; coin: string; card?: CoinCardV2; finding?: boolean }) {
  const status = row.status === 'fine' ? D.fine : row.status === 'flagged' ? D.flagged : row.status === 'checked' ? D.checked : row.status === 'not_applicable' ? D.notApplicable : NOT_CHECKED;
  return <li className="guard-detail-row" data-result={row.status}>
    <details className="ev"><summary><span className="guard-result-label">{status}</span> {finding ? row.text : row.label}<span className="guard-evidence-hint"> · {D.evidence}</span></summary>
      <Fields value={row.value} coin={coin} card={card} /><EvidenceLinks coin={coin} ids={row.evidenceIds} />
    </details>
  </li>;
}
function RatingDetail({ card, guard, evidenceOpen = false }: { card?: CoinCardV2; guard?: GuardAssessmentV2; evidenceOpen?: boolean }) {
  const now = useNow();
  const mode = useUi(s => s.riskMode), setUi = useUi(s => s.set);
  const model = guardDetailModel(card ?? null, guard ?? null), coin = card?.identity.address ?? guard!.coin;
  return <div className="guard-card" id={guard?.mode === 'active' || !guard ? 'coin-evidence' : 'guard-shadow-evidence'} tabIndex={-1}>
    {/* Without a recorded result there is nothing to read here: show only the technical record, not a wall of empty rows. */}
    {guard && <section className="panel guard-assessment">
      <div className="panel-head coin-section-head"><h3>{D.findings}</h3><VerdictChip level="pending" guard={guard} size="lg" showGaps={false} /></div>
      <div className="panel-body">
        {model.flagged.length + model.fine.length > 0 ? <ul className="guard-findings" aria-label={D.findings}>{model.flagged.map(row => <DetailRow key={row.id} row={row} coin={coin} card={card} finding />)}
          {model.sections.filter(section => section.fine > 0).map(section => <li className="guard-detail-row" data-result="fine" key={section.id}><details className="ev"><summary><span className="guard-result-label">{D.fine}</span> {guardFineSectionText(section.title, section.fine)}<span className="guard-evidence-hint"> · {D.evidence}</span></summary><ul className="guard-detail-list">{model.fine.filter(row => row.section === section.id).map(row => <li key={row.id}><p>{row.text}</p><Fields value={row.value} coin={coin} card={card} /><EvidenceLinks coin={coin} ids={row.evidenceIds} /></li>)}</ul></details></li>)}
        </ul>
          : <p>{D.empty}</p>}
      </div>
    </section>}
    {guard && (model.pending.length > 0 || model.excluded.length > 0) && <details className="panel guard-section guard-not-run">
      <summary className="panel-head">{guardNotRunText(model.pending.filter(isCheckRow).length, model.pending.filter(r => !isCheckRow(r)).length, model.excluded.length)}</summary>
      <div className="panel-body">{model.notRun.map(group => <section key={group.reason} data-reason={group.reason}><h4>{group.title} <span className="muted">({group.rows.length})</span></h4>
        <ul className="guard-detail-list">{group.rows.map(row => <DetailRow key={row.id} row={row} coin={coin} card={card} />)}</ul>
      </section>)}</div>
    </details>}
    {guard && <div className="guard-groups">{model.sections.map(section => <details className="panel guard-section guard-question" key={section.id} open={section.flagged > 0 || undefined}>
      <summary className="panel-head"><span className="guard-question-title">{section.title}</span><span className="guard-section-counts">{guardSectionCounts(section.fine, section.flagged, section.pending, section.measured, section.excluded)}</span><small className="guard-technical-title">{section.technical}</small></summary>
      <div className="panel-body"><ul className="guard-detail-list">{section.rows.map(row => <DetailRow key={row.id} row={row} coin={coin} card={card} />)}</ul></div>
    </details>)}</div>}
    {guard && <div className="guard-policy"><GuardPolicyControls guard={guard} mode={mode} onChange={riskMode => setUi({ riskMode })} /></div>}
    <details className="panel guard-section guard-technical">
      <summary className="panel-head">{D.technical}</summary><div className="panel-body">
        {!guard && <p className="muted">{GUARD2_UNAVAILABLE_TITLE}</p>}
        {guard && <><p className="num">{guardSnapshotText(guard, now)}</p><p>{C.receipt} {guard.receipt.status} · <Link to={`/receipt/${guard.receipt.id}`}>{C.verify}</Link> · {C.receiptNote}</p></>}
        {card?.legacy && <p>{guardLegacyText(card.legacy)} · <Link to={`/receipt/${card.legacy.receiptId}`}>{C.originalReceipt}</Link></p>}
        {card && (card.signal || card.spark8h || card.change24hPct) && <CardDetails title={C.signal}>
          {card.signal && <><h3>{C.signal} <span className="tag">{C.beta}</span></h3><p>{C.descriptive} · {card.verdict?.mode === 'active' ? C.recordedInputs : C.shadowInputs}</p><p>{C.composite} {guard?.level === 'high' ? C.high : card.signal.composite} / 100 · {C.block} {card.signal.asOfBlock}</p><details className="ev"><summary>{C.how}</summary><dl className="kv">{Object.entries(card.signal.readings).map(([key, value]) => <div key={key}><dt>{guardName(key)} · {Math.round(card.signal!.weights[key as keyof typeof card.signal.weights] * 100)}%</dt><dd>{card.signal!.lowData.includes(key as keyof typeof card.signal.readings) ? NOT_CHECKED : `${value} · ${(value * card.signal!.weights[key as keyof typeof card.signal.weights]).toFixed(1)} ${C.points}`}</dd></div>)}</dl></details></>}
          {card.spark8h && <Spark series={card.spark8h.map(b => b.c)} label={C.spark} />}
          {card.change24hPct && <><h3>{C.change}</h3><MetricView metric={card.change24hPct} card={card} coin={coin} /></>}
        </CardDetails>}
        {card && <CardDetails title={C.routeTable}><div className="guard-quotes"><table className="table"><thead><tr>{GUARD_QUOTE_HEADINGS.map(v => <th key={v}>{v}</th>)}</tr></thead><tbody>{[...card.tradeability.quotes].sort((a, b) => a.sizeUsd - b.sizeUsd || a.accountClass.localeCompare(b.accountClass)).map(q => <tr key={`${q.sizeUsd}:${q.accountClass}`}><th>${q.sizeUsd.toLocaleString('en-US')}</th><td>{q.accountClass === 'eoa' ? C.eoa : C.smartAccount}</td><td>{q.routeId ?? NOT_CHECKED}</td>{[q.entry, q.sellability, q.venueCostPct, q.allInCostPct, q.gasUsd].map((m, i) => <td key={i}><MetricView metric={m} card={card} coin={coin} /></td>)}</tr>)}</tbody></table></div></CardDetails>}
        {card && GUARD_GROUPS.map(([key, title]) => <CardDetails title={title} key={key}><Fields value={model.technical.card![key]} coin={coin} card={card} /></CardDetails>)}
        <details className="ev" open={evidenceOpen || undefined}><summary>{D.fullRecord} · {C.allReasons}</summary>
          {guard && <><ul>{guard.reasons.map((r, i) => <li key={i}>{formatGuardReason(r)} <EvidenceLinks coin={coin} ids={r.evidenceIds} /></li>)}</ul>
            <div className="guard-checks">{guard.checks.map(c => <details className="ev guard-check" key={c.id}><summary>{GUARD_CHECK_LABELS[c.id]} · {GUARD_CHECK_STATUS[c.status]}</summary><Coverage value={c.coverage} /><EvidenceLinks coin={coin} ids={c.evidenceIds} /></details>)}</div></>}
          <Fields value={model.technical.assessment} coin={coin} card={card} />
          {card && <><h4>{C.source}</h4><Fields value={card.freshness} coin={coin} card={card} /><Fields value={card.source ?? null} coin={coin} card={card} /><Fields value={card.jobs ?? []} field="jobs" coin={coin} card={card} />
            <h4>{C.captured}</h4><Fields value={card.evidence} coin={coin} card={card} /><Fields value={card.factorMeasurements ?? []} coin={coin} card={card} /><Fields value={card.collectionCoverage ?? null} coin={coin} card={card} />
          </>}
        </details>
      </div>
    </details>
    <AnalysisPolicyNotice />
  </div>;
}
export function GuardAssessment({ guard, evidenceOpen = false }: { guard: GuardAssessmentV2; evidenceOpen?: boolean }) {
  return <RatingDetail guard={guard} evidenceOpen={evidenceOpen} />;
}
export function GuardCard({ card, assessment, evidenceOpen = false }: { card: CoinCardV2; assessment?: GuardAssessmentV2; evidenceOpen?: boolean }) {
  return <RatingDetail card={card} guard={assessment ?? card.verdict ?? undefined} evidenceOpen={evidenceOpen} />;
}
