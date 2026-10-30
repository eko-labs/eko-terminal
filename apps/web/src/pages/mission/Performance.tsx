import { MISSION_LABELS as L, MISSION_TEXT as T } from '../../copy/mission';
import { useMemo, useState } from 'react';
import { ChartPlate } from '../../components/ui/ChartPlate';
import { useWidth } from '../../components/ui/charts';
import type { Metrics } from './Agents';
import { MISSION_COPY as C } from '../../copy/mission';
import { money, signed } from './parts';

interface Finding { i: number; label: string }
// Prototype annotations avoid the trace and each other; narrow charts use numbered markers.
function placeFinding(placed: { x: number; y: number; w: number; h: number }[], points: number[][], px: number, py: number, label: string, width: number, top: number, bottom: number) {
  let lines = [label];
  if (label.length > 20) for (let k = label.indexOf(' '); k > 0; k = label.indexOf(' ', k + 1)) {
    const candidate = [label.slice(0, k), label.slice(k + 1)];
    if (lines.length === 1 || Math.max(...candidate.map((v) => v.length)) < Math.max(...lines.map((v) => v.length))) lines = candidate;
  }
  const w = Math.max(...lines.map((v) => v.length)) * 6.6 + 4, h = 16 + lines.length * 15, flip = px + 10 + w > width - 6, x = flip ? px - 10 - w : px + 10;
  const overlaps = (y: number) => placed.some((b) => x < b.x + b.w + 8 && x + w + 8 > b.x && y < b.y + b.h + 4 && y + h + 4 > b.y);
  const span = points.filter(([qx]) => qx >= x - 4 && qx <= x + w + 4).map(([, qy]) => qy), hi = Math.min(py, ...span), lo = Math.max(py, ...span);
  const options = [py - 16 - h, hi - 10 - h, py - 54 - h, hi - 48 - h, py + 16, lo + 12, py + 54, top - h - 4];
  const fits = (y: number) => y >= 4 && y + h <= bottom - 4 && !overlaps(y);
  const y = options.find((y) => fits(y) && (y + h + 6 <= hi || y - 6 >= lo)) ?? options.find(fits) ?? Math.max(4, py - 16 - h);
  placed.push({ x, y, w, h }); return { lines, y, h, x: flip ? x + w : x, anchor: flip ? 'end' as const : 'start' as const };
}
function PerformanceChart({ series, bars = false, height, events = [] }: { series: readonly number[]; bars?: boolean; height: number; events?: Finding[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(), [hover, setHover] = useState<number | null>(null), compact = bars || width < 560;
  const g = useMemo(() => {
    const lo = Math.min(0, ...series), hi = Math.max(...series), pad = (hi - lo) * .12, m = Math.max(10, Math.ceil(Math.max(...series.map(Math.abs)) / 10) * 10);
    const low = bars ? -m : Math.floor((lo - pad) / 10) * 10, high = bars ? m : Math.ceil((hi + pad) / 10) * 10;
    const L = compact ? 34 : 46, R = compact ? 34 : 46, T = compact ? 14 : 22, B = height - 26;
    return { W: width, H: height, L, R, T, B, lo: low, zero: low < 0, series, x: (i: number) => bars ? L + (i + .5) / series.length * (width - L - R) : L + i / Math.max(1, series.length - 1) * (width - L - R), y: (v: number) => B - (v - low) / (high - low || 1) * (B - T), high };
  }, [width, height, series, bars, compact]);
  const points = series.map((v, i) => [g.x(i), g.y(v)]), placed: { x: number; y: number; w: number; h: number }[] = [], ticks = [g.lo, (g.lo + g.high) / 2, g.high];
  return <div ref={ref} className="mc-performance-chart" style={{ height }}>{width > 0 && <><ChartPlate kind={bars ? 'bars' : 'area'} geometry={g} label={bars ? L.dailyProfitAndLoss30Days : L.cumulativeProfitAndLoss30Days} /><svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">{ticks.map((v) => <g key={v}><line x1={g.L} x2={width - g.R} y1={g.y(v)} y2={g.y(v)} stroke="var(--rule)" /><text x={g.L - 8} y={g.y(v) + 3.5} textAnchor="end">{money(Math.round(v))}</text></g>)}{[0, 15, 29].map((i) => <text key={i} x={g.x(i)} y={height - 8} textAnchor={i === 29 ? 'end' : i === 0 ? 'start' : 'middle'}>{i === 29 ? L.today : T.daysAgo(29 - i)}</text>)}
    {events.map((event, k) => {
      const px = g.x(event.i), py = g.y(series[event.i]), p = placeFinding(placed, points, px, py, event.label, width - g.R, g.T, g.B);
      return <g key={event.label} className="mc-chart-finding"><line x1={px} x2={px} y1={py + 5} y2={g.B} stroke="var(--accent)" strokeDasharray="2 3" opacity=".4" />{compact ? <text x={px} y={py - 11} textAnchor="middle">{String(k + 1).padStart(2, '0')}</text> : <><path d={p.y < py ? `M${px},${py - 5}V${p.y + p.h - 2}` : `M${px},${py + 5}V${p.y + 2}`} stroke="var(--accent)" fill="none" opacity=".55" /><text x={p.x} y={p.y + 11} textAnchor={p.anchor}><tspan>{String(k + 1).padStart(2, '0')}</tspan>{p.lines.map((line, j) => <tspan key={j} x={p.x} dy="15">{line}</tspan>)}</text></>}<circle cx={px} cy={py} r="4.5" fill="var(--plate)" stroke="var(--lit)" strokeWidth="1.5" /></g>;
    })}
    {!bars && <g><circle cx={g.x(series.length - 1)} cy={g.y(series.at(-1)!)} r="3.2" fill="#f4fbff" /><text x={g.x(series.length - 1) + 8} y={g.y(series.at(-1)!) + 4}>{money(series.at(-1)!)}</text></g>}
    {hover !== null && <g pointerEvents="none"><line x1={g.x(hover)} x2={g.x(hover)} y1={g.T - 6} y2={g.B} stroke="var(--lit)" opacity=".35" /><circle cx={g.x(hover)} cy={g.y(series[hover])} r="3.5" fill="#fff" stroke="var(--plate)" strokeWidth="2" /></g>}
    <rect x={g.L} y="0" width={Math.max(0, width - g.L - g.R)} height={g.B} fill="transparent" style={{ cursor: 'crosshair' }} onPointerLeave={() => setHover(null)} onPointerMove={(e) => { const f = (e.clientX - e.currentTarget.ownerSVGElement!.getBoundingClientRect().left - g.L) / Math.max(1, width - g.L - g.R); setHover(Math.max(0, Math.min(series.length - 1, bars ? Math.floor(f * series.length) : Math.round(f * (series.length - 1))))); }} />
    </svg></>}{hover !== null && <div className="mc-chart-tip" style={{ left: g.x(hover) + 184 > width ? g.x(hover) - 184 : g.x(hover) + 14, top: Math.max(4, g.y(series[hover]) - 58) }}><span>{hover === 29 ? L.today : T.daysAgo(29 - hover)}</span><b className="num">{money(series[hover])}</b><span>{bars ? L.pLThatDay : L.cumulativePL}</span>{events.find((e) => Math.abs(e.i - hover) <= 1)?.label}</div>}</div>;
}
export default function Performance({ metrics }: { metrics?: Metrics[string] }) {
  const p = metrics?.performance;
  if (!p) return <section className="panel"><div className="panel-body">{L.performanceHasNotBeenReported}</div></section>;
  return <div className="mc-split"><div className="mc-performance-main"><div className="stats-row mc-stats"><div className="stat"><span className="label">{L.pAmpL30Days}</span><span className="value">{signed(p.pnl30)}</span><span className="sub">{L.text24h}{' '}{signed(metrics!.pnl24hUsd)}</span></div><div className="stat"><span className="label">{L.closedInProfit}</span><span className="value">{p.profitPct}%</span><span className="sub">{L.of2}{' '}{p.trades} {L.closedTrades}</span></div><div className="stat"><span className="label">{L.averageHold}</span><span className="value">{p.hold}</span><span className="sub">{L.entryToExit}</span></div><div className="stat"><span className="label">{L.deepestDrawdown}</span><span className="value">{signed(p.maxDrawdown)}</span><span className="sub">{L.worstDay}{' '}{signed(p.worst)}</span></div></div>
  <section className="panel"><div className="panel-head"><h3>{L.cumulativePAmpL}</h3><span className="muted">{L.text30DaysFromTheAgentSJournal}</span></div><div className="panel-body"><PerformanceChart series={p.cumul} height={280} events={p.events} /><span className="eyebrow">{L.dailyPAmpL}</span><PerformanceChart series={p.daily} bars height={130} /></div></section></div><aside className="mc-aside"><section className="panel"><div className="panel-head"><h3>{L.openPositions}</h3><span className="num">{money(p.positions.reduce((n, x) => n + x.usd, 0))}</span></div><div className="panel-body"><table className="table"><thead><tr><th>{L.position}</th><th className="r">{L.size}</th><th className="r">{L.unrealised}</th></tr></thead><tbody>{p.positions.map((x) => <tr key={x.symbol}><td>{x.symbol}</td><td className="r num">{money(x.usd)}</td><td className="r num">{signed(x.pnl)}</td></tr>)}</tbody><tfoot><tr><td>{L.total}</td><td className="r num">{money(p.positions.reduce((n, x) => n + x.usd, 0))}</td><td className="r num">{signed(p.positions.reduce((n, x) => n + x.pnl, 0))}</td></tr></tfoot></table></div></section><p className="note">{C.performanceNote}</p></aside></div>;
}
