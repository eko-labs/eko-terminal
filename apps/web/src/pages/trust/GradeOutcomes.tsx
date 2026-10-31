import { useEffect, useState } from 'react';
import { z } from 'zod';
import { fetchParsed } from '../../lib/api';
import { NO_FLAGS } from '../../copy/availability';

const OutcomeRows = z.array(z.object({ level: z.enum(['clear', 'monitor', 'danger']), horizonSec: z.number(), ratings: z.number(), down50: z.number(), down50NeverUp20: z.number() }));
export const GradeOutcomesSchema = z.object({ since: z.string(), computedAt: z.string(), rows: OutcomeRows,
  // Coins that launched in a Uniswap pool, measured apart (absent from a server that predates them).
  uniswap: z.object({ since: z.string(), rows: OutcomeRows }).optional() });
export type GradeOutcomes = z.infer<typeof GradeOutcomesSchema>;
const LEVELS = [['danger', 'Danger'], ['monitor', 'Monitor'], ['clear', NO_FLAGS]] as const;
/** Fewer graded coins than this is too few to read a rate from; the cell shows the count alone. */
export const MIN_RATINGS = 30;
export function outcomeText(row: GradeOutcomes['rows'][number] | undefined): string {
  if (!row || row.ratings === 0) return 'No coins old enough yet';
  if (row.ratings < MIN_RATINGS) return `${row.down50} of ${row.ratings} (too few to read a rate)`;
  const pct = 100 * row.down50 / row.ratings;
  return `${row.down50} of ${row.ratings.toLocaleString('en-US')} · ${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
}
const utc = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
/** What happened to coins after EKO graded them: EKO's own measurement, shown above the record that waits for review. */
function OutcomeTable({ rows, caption }: { rows: GradeOutcomes['rows']; caption: string }) {
  const cell = (level: string, horizonSec: number) => rows.find(r => r.level === level && r.horizonSec === horizonSec);
  return <table className="grade-outcomes"><caption>{caption}</caption><thead><tr><th scope="col">Grade</th><th scope="col">Down 50% or more 1 hour later</th><th scope="col">Down 50% or more 24 hours later</th></tr></thead>
    <tbody>{LEVELS.map(([level, label]) => { const hour = cell(level, 3600), day = cell(level, 86400);
      return <tr key={level}><th scope="row">{label}</th><td className="num">{outcomeText(hour)}{hour && hour.down50 > 0 && hour.ratings >= MIN_RATINGS ? <span className="muted"> · {hour.down50NeverUp20} never up 20% first</span> : null}</td>
        <td className="num">{outcomeText(day)}{day && day.down50 > 0 && day.ratings >= MIN_RATINGS ? <span className="muted"> · {day.down50NeverUp20} never up 20% first</span> : null}</td></tr>; })}</tbody></table>;
}
export function GradeOutcomesView({ data }: { data: GradeOutcomes }) {
  return <section className="panel"><div className="panel-head"><h2>How each grade did</h2></div><div className="panel-body">
    <p>Coins whose price was down 50% or more after EKO graded them, for each grade. A coin counts if it traded in the hour before its grade, so a buyer could have bought it then.</p>
    <OutcomeTable rows={data.rows} caption="Pons launches" />
    {data.uniswap && <><OutcomeTable rows={data.uniswap.rows} caption="Coins that launched in a Uniswap pool" />
      <p className="muted">Uniswap launches have been graded since {utc(data.uniswap.since)} UTC, by rules whose thresholds were set on Pons launches. This table is how those thresholds are checked on them.</p></>}
    <p className="muted">EKO’s own measurement from indexed trades, for grades given since {utc(data.since)} UTC under the current rules; updated {utc(data.computedAt)} UTC. It has not been independently reviewed, and it is not the accepted record the counters below wait for. A grade describes buyer risk; it is not a forecast.</p>
  </div></section>;
}
export function GradeOutcomesPanel({ revision }: { revision: number }) {
  const [data, setData] = useState<GradeOutcomes | null>(null);
  useEffect(() => { const ac = new AbortController(); void fetchParsed('/scoreboard/grades', GradeOutcomesSchema, { signal: ac.signal }).then(setData).catch(() => undefined); return () => ac.abort(); }, [revision]);
  return data ? <GradeOutcomesView data={data} /> : null;
}
