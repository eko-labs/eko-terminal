import { useEffect, useRef } from 'react';
import type { AreaGeometry, BarsGeometry, CandlesGeometry } from '../../lib/phosphor';
import { paintArea, paintBars, paintCandles, sweep } from '../../lib/phosphor';

type ChartPlateProps = { label: string; animate?: boolean } & (
  { kind: 'area'; geometry: AreaGeometry } | { kind: 'bars'; geometry: BarsGeometry } | { kind: 'candles'; geometry: CandlesGeometry }
);
/** Light is confined to a chart plate. The accessible label describes the supplied data. */
export function ChartPlate(props: ChartPlateProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    return sweep((progress) => {
      if (props.kind === 'area') paintArea(canvas, props.geometry, progress);
      else if (props.kind === 'bars') paintBars(canvas, props.geometry, progress);
      else paintCandles(canvas, props.geometry, progress);
    }, { dur: 640, animate: props.animate ?? true });
  }, [props.kind, props.geometry, props.animate]);
  return <canvas className="chart-plate" ref={ref} role="img" aria-label={props.label} style={{ width: props.geometry.W, maxWidth: '100%', height: 'auto', aspectRatio: `${props.geometry.W}/${props.geometry.H}` }} />;
}
