import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries,
  BaselineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { formatPct, formatUsd, type BacktestTrade } from '@eko/shared';
import { CHART_THEME, COLORS } from '../chart/chartCore';

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

export interface EquityPoint {
  time: number;
  equity: number;
  drawdownPct: number;
}

/**
 * Canvas primitive marking the in-sample / out-of-sample boundary: a dashed rule, a faint
 * wash over the held-out segment and (optionally) labels either side of the rule.
 */
class SplitMarker implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private x: number | null = null;
  private readonly views: IPrimitivePaneView[];

  constructor(
    private readonly time: number,
    private readonly withLabels: boolean,
  ) {
    const renderer: IPrimitivePaneRenderer = {
      draw: () => undefined,
      drawBackground: (target: DrawTarget) => this.paint(target),
    };
    this.views = [{ zOrder: () => 'bottom', renderer: () => renderer }];
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
  }
  detached() {
    this.chart = null;
  }
  updateAllViews() {
    this.x = this.chart?.timeScale().timeToCoordinate(this.time as UTCTimestamp) ?? null;
  }
  paneViews() {
    return this.views;
  }

  private paint(target: DrawTarget) {
    const x0 = this.x;
    if (x0 === null) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const x = Math.round(x0) + 0.5;
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.022)';
      ctx.fillRect(x, 0, Math.max(0, mediaSize.width - x), mediaSize.height);
      ctx.strokeStyle = 'rgba(236,238,241,0.34)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, mediaSize.height);
      ctx.stroke();
      ctx.setLineDash([]);
      if (this.withLabels) {
        ctx.font = "600 9.5px 'Geist Mono Variable', ui-monospace, monospace";
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(174,180,189,0.78)';
        if (x > 96) {
          ctx.textAlign = 'right';
          ctx.fillText('IN-SAMPLE', x - 8, 8);
        }
        if (mediaSize.width - x > 110) {
          ctx.textAlign = 'left';
          ctx.fillStyle = 'rgba(236,238,241,0.9)';
          ctx.fillText('OUT-OF-SAMPLE', x + 8, 8);
        }
      }
      ctx.restore();
    });
  }
}

const localTime = (t: Time) => new Date((t as number) * 1000);

interface Hover {
  time: number;
  equity: number;
  dd: number;
}

/**
 * Equity curve (baseline at starting equity: above = mint, below = red) with a drawdown pane
 * and the in-sample / out-of-sample split marked on both panes.
 */
export function EquityChart({
  equity,
  splitTime,
  startingEquity,
  trades,
  showTrades,
  height = 360,
}: {
  equity: EquityPoint[];
  splitTime: number | null;
  startingEquity: number;
  trades?: BacktestTrade[];
  showTrades?: boolean;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const last = equity[equity.length - 1];
  const worst = useMemo(() => equity.reduce((m, e) => Math.min(m, e.drawdownPct), 0), [equity]);


  useEffect(() => {
    const el = ref.current;
    if (!el || !equity.length) return;
    const T = CHART_THEME;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: T.text,
        fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: false,
        panes: { separatorColor: T.sep, separatorHoverColor: T.border, enableResize: false },
      },
      grid: { vertLines: { color: T.grid }, horzLines: { color: T.grid } },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: T.cross, width: 1, style: LineStyle.Dashed, labelBackgroundColor: T.label },
        horzLine: { color: T.cross, width: 1, style: LineStyle.Dashed, labelBackgroundColor: T.label },
      },
      rightPriceScale: { borderColor: T.border, scaleMargins: { top: 0.12, bottom: 0.06 }, minimumWidth: 72 },
      timeScale: {
        borderColor: T.border,
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (t: Time, type: number) => {
          const d = localTime(t);
          // Year/month/day tick marks sit on UTC boundaries, so label them in UTC (a local-time label can read as the previous day or month).
          if (type <= 1) return d.toLocaleDateString(undefined, { year: type === 0 ? 'numeric' : undefined, month: 'short', timeZone: 'UTC' });
          if (type === 2) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
          return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
        },
      },
      localization: {
        timeFormatter: (t: Time) => localTime(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
      },
      // Page scroll must keep working over the chart: no wheel zoom/scroll, drag and pinch only.
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: { time: true, price: false }, axisDoubleClickReset: true },
      kineticScroll: { mouse: false, touch: true },
    });

    const eq = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: startingEquity },
      topLineColor: COLORS.up,
      topFillColor1: 'rgba(25,217,159,0.18)',
      topFillColor2: 'rgba(25,217,159,0.02)',
      bottomLineColor: COLORS.down,
      bottomFillColor1: 'rgba(240,68,90,0.02)',
      bottomFillColor2: 'rgba(240,68,90,0.18)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 3,
      priceFormat: { type: 'custom', minMove: 1, formatter: (v: number) => formatUsd(v, 0) },
    });
    eq.setData(equity.map((p) => ({ time: p.time as UTCTimestamp, value: p.equity })));
    eq.createPriceLine({ price: startingEquity, color: 'rgba(236,238,241,0.22)', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });

    const dd = chart.addSeries(
      AreaSeries,
      {
        lineColor: 'rgba(240,68,90,0.85)',
        topColor: 'rgba(240,68,90,0.04)',
        bottomColor: 'rgba(240,68,90,0.26)',
        invertFilledArea: true,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerRadius: 2,
        priceFormat: { type: 'custom', minMove: 0.01, formatter: (v: number) => `${v.toFixed(1)}%` },
      },
      1,
    );
    dd.setData(equity.map((p) => ({ time: p.time as UTCTimestamp, value: p.drawdownPct })));
    chart.panes()[1]?.setHeight(Math.round(height * 0.24));

    if (splitTime) {
      eq.attachPrimitive(new SplitMarker(splitTime, true));
      dd.attachPrimitive(new SplitMarker(splitTime, false));
    }

    if (showTrades && trades?.length) {
      const have = new Set(equity.map((p) => p.time));
      const markers: SeriesMarker<Time>[] = [];
      for (const t of trades) {
        if (have.has(t.entryTime)) markers.push({ time: t.entryTime as UTCTimestamp, position: 'belowBar', shape: 'arrowUp', color: 'rgba(25,217,159,0.8)', size: 0.6 });
        if (have.has(t.exitTime)) markers.push({ time: t.exitTime as UTCTimestamp, position: 'aboveBar', shape: 'circle', color: 'rgba(240,68,90,0.75)', size: 0.45 });
      }
      markers.sort((a, b) => (a.time as number) - (b.time as number));
      createSeriesMarkers(eq, markers);
    }

    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((p) => {
      if (p.time === undefined) {
        setHover(null);
        return;
      }
      const e = p.seriesData.get(eq) as { value?: number } | undefined;
      const d = p.seriesData.get(dd) as { value?: number } | undefined;
      if (e?.value === undefined) return;
      setHover({ time: p.time as number, equity: e.value, dd: d?.value ?? 0 });
    });
    return () => chart.remove();
  }, [equity, splitTime, startingEquity, trades, showTrades, height]);

  const shown = hover ?? (last ? { time: last.time, equity: last.equity, dd: last.drawdownPct } : null);
  const ret = shown ? ((shown.equity - startingEquity) / startingEquity) * 100 : null;

  return (
    <div className="eqc">
      <div className="eqc-legend num" aria-live="off">
        <span>
          <span className="muted">{hover ? localTime(hover.time as Time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : 'End'}</span>
        </span>
        <span>
          <span className="muted">Equity</span> {formatUsd(shown?.equity ?? null)}{' '}
          <span className={ret !== null && ret >= 0 ? 'up' : 'down'}>{formatPct(ret)}</span>
        </span>
        <span>
          <span className="muted">Drawdown</span> <span className={shown && shown.dd < 0 ? 'down' : ''}>{formatPct(shown?.dd ?? null, 2, false)}</span>
        </span>
        <span className="eqc-worst">
          <span className="muted">Worst</span> <span className="down">{formatPct(worst, 2, false)}</span>
        </span>
      </div>
      <div
        ref={ref}
        className="eqc-canvas"
        style={{ height }}
        role="img"
        aria-label={`Equity curve from ${formatUsd(startingEquity, 0)} to ${formatUsd(last?.equity ?? null, 0)}, maximum drawdown ${formatPct(worst, 1, false)}${splitTime ? '. Dashed line marks the start of the out-of-sample segment.' : ''}`}
      />
    </div>
  );
}
