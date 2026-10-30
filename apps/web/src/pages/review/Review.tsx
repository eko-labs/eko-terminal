import { useEffect, useState } from 'react';
import { Bytes32Schema, ReviewQuestionsSchema, type ReviewView, type ReviewRole } from '@eko/shared';
import { UntrustedText } from '../../components/ui';
import { DYOR } from '../../copy';
import { BUYER_RISK, GUARD_LABELS } from '../../copy/guard';
import { REVIEW_COPY as C, REVIEW_PANELS, REVIEW_PROMPTS, REVIEW_QUESTIONS } from '../../copy/review';
import { useApp } from '../../store/app';
import { reviewClient } from './client';
import { canWrite, currentJudgment, emptyAnswers, factText, judgmentInput, plotPoints, type Answers, type Panel } from './model';
import './review.css';

const kinds = Object.keys(REVIEW_PANELS) as Panel['kind'][];
function EvidenceLinks({ ids }: { ids: string[] }) {
  return <ul className="review-evidence-links">{ids.map(id => <li key={id}><a href={`#evidence-${id}`}><code>{id}</code></a></li>)}</ul>;
}
function ReviewPlot({ panels }: { panels: Panel[] }) {
  const points = plotPoints(panels);
  if (!points.length) return <p>{C.plotMissing}</p>;
  return <figure><svg viewBox="0 0 600 210" role="img" aria-label={C.plotNote}>
    <path d="M40 30V175H560" fill="none" stroke="currentColor" />
    {points.map(point => <a key={point.index} href={`#panel-${panels[point.index].kind}-${point.index}`}><circle cx={point.x} cy={point.y} r="5" fill="currentColor"><title>{point.timestamp} s · {point.returnText}%</title></circle></a>)}
    <text x="40" y="200">{points.reduce((a, b) => BigInt(a.timestamp) < BigInt(b.timestamp) ? a : b).timestamp} s</text>
    <text x="560" y="200" textAnchor="end">{points.reduce((a, b) => BigInt(a.timestamp) > BigInt(b.timestamp) ? a : b).timestamp} s</text>
  </svg><figcaption>{C.plotNote}</figcaption><ul>{points.map(point => <li key={point.index}><a href={`#panel-${panels[point.index].kind}-${point.index}`}>{point.timestamp} s · {point.returnText}%</a></li>)}</ul></figure>;
}
function FactPanel({ panel, index }: { panel: Panel; index: number }) {
  return <article id={`panel-${panel.kind}-${index}`} tabIndex={-1} data-status={panel.status}>
    <h3>{REVIEW_PANELS[panel.kind]} · {index + 1}</h3><strong>{C[panel.status]}</strong>
    <dl>{panel.facts.map((fact, i) => <div key={i}><dt>{fact.field.replaceAll('_', ' ')}</dt><dd>{factText(fact.value)}</dd></div>)}</dl>
    {panel.text && <p><UntrustedText value={panel.text} /></p>}<EvidenceLinks ids={panel.evidenceIds} />
  </article>;
}
export function ReviewEvidence({ view }: { view: ReviewView }) {
  const c = view.case;
  return <>
    <section className="panel"><h2>{C.context}</h2><p>{c.origin === 'fixture' ? C.fixture : C.measured}</p>
      <dl><div><dt>Case revision</dt><dd><code>{c.id}</code> · {c.revision}</dd></div><div><dt>Coin / chain</dt><dd><code>{c.coin}</code> / {c.cursor.chainId}</dd></div>
        <div><dt>Route / USD size / account class</dt><dd>{c.context.routeId} / ${c.context.sizeUsd} / {c.context.accountClass}</dd></div>
        <div><dt>Cursor / time</dt><dd>{c.cursor.blockNumber} / {c.cursor.boundary} / {c.cursor.timestampSec} s · tx {c.cursor.transactionIndex ?? 'Unknown'} · ordinal {c.cursor.executionOrdinal ?? 'Unknown'}<br /><code>{c.cursor.blockHash}</code></dd></div>
        <div><dt>Availability</dt><dd>{c.availability.cursor.blockNumber} / {c.availability.cursor.timestampSec} s · acquisition {c.availability.acquisitionSequence}<br /><code>{c.availability.cursor.blockHash}</code></dd></div>
        <div><dt>Method</dt><dd>{c.method.version} / {c.method.replayMode} / {c.method.benchmarkMethod}</dd></div>
      </dl><p>{C.parity}</p>
    </section>
    <section className="panel"><h2>{C.guidance}</h2><ol>{REVIEW_PROMPTS.map(prompt => <li key={prompt}>{prompt}</li>)}</ol></section>
    <section className="panel"><h2>{C.machine}</h2><p>{c.machineOutcome.status} · exit {c.machineOutcome.exitStatus} · buyer harm {factText(c.machineOutcome.buyerHarm)}</p></section>
    <div className="review-panels">{kinds.map(kind => {
      const panels = c.panels.filter(p => p.kind === kind);
      return <section className="panel" key={kind}><h2>{REVIEW_PANELS[kind]}</h2>
        {kind === 'role' && <ul>{c.identity.roles.map((role, i) => <li key={i}>{role.role.replaceAll('_', ' ')} · {role.status} · {role.address ?? C.unknown}<EvidenceLinks ids={role.evidenceIds} /></li>)}</ul>}
        {(kind === 'intervention' || kind === 'real_buyer') && <ReviewPlot panels={panels} />}
        {panels.length ? panels.map((panel, index) => <FactPanel key={index} panel={panel} index={index} />) : <p>{C.absent}</p>}
      </section>;
    })}</div>
    <section className="panel"><h2>{C.evidence}</h2><ul>{c.evidenceIds.map(id => <li id={`evidence-${id}`} tabIndex={-1} key={id}><code>{id}</code>
      <ul>{c.panels.flatMap(panel => panel.evidenceIds.includes(id) ? [panel] : []).map((panel, i) => <li key={i}><a href={`#panel-${panel.kind}-${c.panels.filter(p => p.kind === panel.kind).indexOf(panel)}`}>{REVIEW_PANELS[panel.kind]} · {C[panel.status]}</a></li>)}</ul>
      {!c.panels.some(panel => panel.evidenceIds.includes(id)) && <p>{C.evidenceUnavailable}</p>}
    </li>)}</ul></section>
    <details className="panel"><summary>{C.pins}</summary><dl>{Object.entries(c.pins).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value}</code></dd></div>)}
      <div><dt>Source revision</dt><dd><code>{c.sourceRevision}</code></dd></div><div><dt>Candidate revision</dt><dd><code>{c.candidateRevision}</code></dd></div>
    </dl><pre>{JSON.stringify({ cursor: c.cursor, availability: c.availability, identity: c.identity, method: c.method, machineOutcome: c.machineOutcome }, null, 2)}</pre></details>
  </>;
}
export function ReviewHistory({ view }: { view: ReviewView }) {
  // Guard even against accidentally supplied client state: blindness controls every reveal surface.
  if (view.blinded) return <p role="status">{C.blinded}</p>;
  const reveal = view.reveal;
  return <><section className="panel"><h2>{C.reveal}</h2><p>V2: {reveal?.points ?? C.unknown} · {reveal?.level ? GUARD_LABELS[reveal.level] : C.unknown}</p>
    <p>Legacy: {reveal?.legacyPoints ?? C.unknown} · {reveal?.legacyLevel ?? C.unknown}</p><h3>{C.alleged}</h3>{reveal?.allegedIncidentLabels.map((text, i) => <p key={i}><UntrustedText value={text} /></p>)}</section>
    <section className="panel"><h2>{C.history} · {view.status}</h2>{!view.labels.length && <p>{C.noHistory}</p>}
      {[...view.labels, ...view.adjudications].map(label => <article key={label.id}><h3>{'slot' in label ? label.slot : C.adjudication} · {label.revision}</h3>
        <p><code>{'reviewerId' in label ? label.reviewerId : label.adjudicatorId}</code> · version {label.labelVersion} · {label.submittedAt}</p>
        <dl>{Object.entries(label.answers).map(([question, answer]) => <div key={question}><dt>{REVIEW_QUESTIONS[question as keyof Answers]}</dt><dd>{answer.replaceAll('_', ' ')}</dd></div>)}</dl>
        <p><UntrustedText value={label.rationale} /></p><EvidenceLinks ids={label.evidenceIds} /><p>ID <code>{label.id}</code> · supersedes <code>{label.supersedes ?? 'none'}</code></p>
        {'labelIds' in label && <p>Independent labels: {label.labelIds.join(' / ')}</p>}
      </article>)}
    </section></>;
}
export function JudgmentForm({ view, role, busy, onSubmit }: { view: ReviewView; role: ReviewRole; busy: boolean; onSubmit: (input: ReturnType<typeof judgmentInput>) => void }) {
  const prior = currentJudgment(view, role);
  const [answers, setAnswers] = useState<Answers>(prior?.answers ?? emptyAnswers());
  const [evidence, setEvidence] = useState<string[]>(prior?.evidenceIds ?? []), [rationale, setRationale] = useState(prior?.rationale.text ?? ''), [version, setVersion] = useState(prior?.labelVersion ?? '2.0.0');
  const [error, setError] = useState('');
  if (!canWrite(view, role)) return <p>{role === 'evaluator' ? C.evaluator : C.pending}</p>;
  return <form className="panel" onSubmit={event => {
    event.preventDefault(); if (busy) return;
    try { const body = judgmentInput(view, role, answers, evidence, rationale, version); setError(''); onSubmit(body); }
    catch { setError(C.required); }
  }}><h2>{role === 'adjudicator' ? C.adjudication : role}</h2><p>{C.independent}</p><fieldset disabled={busy}>
    {Object.entries(ReviewQuestionsSchema.shape).map(([key, schema]) => <label key={key}>{REVIEW_QUESTIONS[key as keyof Answers]}
      <select value={answers[key as keyof Answers]} onChange={event => setAnswers({ ...answers, [key]: event.target.value })}>
        {schema.options.map(option => <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>)}
      </select></label>)}
    <fieldset><legend>{C.evidence}</legend>{view.case.evidenceIds.map(id => <label key={id}><input type="checkbox" checked={evidence.includes(id)} onChange={event => setEvidence(event.target.checked ? [...evidence, id] : evidence.filter(value => value !== id))} /><code>{id}</code></label>)}</fieldset>
    <label>{C.version}<input required pattern="\d+\.\d+\.\d+" value={version} onChange={event => setVersion(event.target.value)} /></label>
    <label>{C.rationale}<textarea required maxLength={4000} value={rationale} onChange={event => setRationale(event.target.value)} /></label>
    <button className="btn" type="submit">{role === 'adjudicator' ? C.adjudicate : prior ? C.revise : C.submit}</button>
  </fieldset>{error && <p role="alert">{error}</p>}</form>;
}
function AssignedReview({ revisionId }: { revisionId: string }) {
  const [data, setData] = useState<{ view: ReviewView; role: ReviewRole } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError('');
    void reviewClient.load(revisionId, controller.signal).then(setData).catch(err => { if (err.name !== 'AbortError') setError(C.unavailable); });
    return () => controller.abort();
  }, [revisionId, refresh]);
  async function submit(input: ReturnType<typeof judgmentInput>) {
    if (!data || busy) return;
    setBusy(true); setError(''); setNotice('');
    try { setData(await reviewClient.submit(revisionId, data.role, input)); setNotice(C.saved); }
    catch { setData(null); setError(C.failure); }
    finally { setBusy(false); }
  }
  async function download() {
    if (!data || busy) return;
    setBusy(true); setError('');
    try {
      const exported = await reviewClient.export(data.view.case.caseId);
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `review-${exported.caseId}-${exported.exportHash}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch { setError(C.unavailable); }
    finally { setBusy(false); }
  }
  return <div className="shell-page review-page"><div className="page-head"><h1>{C.title}</h1></div><p>{C.inactive}</p>
    {error && <p role="alert">{error} <button className="btn" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{C.retry}</button></p>}
    {notice && <p role="status">{notice}</p>}{!data && !error && <p role="status">{C.loading}</p>}
    {data && <><ReviewHistory view={data.view} /><ReviewEvidence view={data.view} />
      <JudgmentForm key={`${data.view.case.id}-${currentJudgment(data.view, data.role)?.id ?? 'first'}`} view={data.view} role={data.role} busy={busy} onSubmit={input => void submit(input)} />
      <section className="panel"><button className="btn" disabled={busy} onClick={() => void download()}>{C.export}</button><p>{C.exportNote}</p></section></>}
    <p>{BUYER_RISK}</p><p>{DYOR}</p>
  </div>;
}
export default function Review({ params }: { params: Record<string, string> }) {
  const revisionId = params.revisionId;
  const accountId = useApp(state => state.account?.id ?? 'signed-out');
  return Bytes32Schema.safeParse(revisionId).success ? <AssignedReview key={`${revisionId}-${accountId}`} revisionId={revisionId} /> : <div className="shell-page"><h1>{C.title}</h1><p role="alert">{C.invalid}</p></div>;
}
