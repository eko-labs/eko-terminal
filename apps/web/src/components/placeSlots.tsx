import { Suspense, useMemo } from 'react';
import type { Flags } from '@eko/shared';
import { FEATURES, type PlaceSlots } from '../features';
import { useShell } from '../store/shell';

/**
 * Places outside the coin page that post-launch features (features.ts `places`) can fill: tools next to a launch filter
 * being edited, a control in the top bar, and a figure in each row of the coin lists. A place shows only while its feature's flag is on; with none on, these render nothing and the page is
 * unchanged. Places may be lazy components: each waits for them quietly.
 */
export function activePlaceSlots(features: readonly ({ flag: keyof Flags } & { places?: PlaceSlots })[], flags: Partial<Flags> | undefined): PlaceSlots[] {
  return features.flatMap(f => f.places && flags?.[f.flag] ? [f.places] : []);
}
export function usePlaceSlots(): PlaceSlots[] {
  const flags = useShell(s => s.config?.flags);
  return useMemo(() => activePlaceSlots(FEATURES, flags), [flags]);
}

/** Next to a launch filter being edited (`filter`: the form's filter as the launch filter API takes it, or null). */
export function LaunchFilterSlots({ filter }: { filter: unknown }) {
  const slots = usePlaceSlots().filter(s => s.launchFilter);
  if (!slots.length) return null;
  return <Suspense fallback={null}>{slots.map((s, i) => { const Tool = s.launchFilter!; return <Tool key={i} filter={filter} />; })}</Suspense>;
}

/** In the top bar on every page (`compact` on the phone bar). Renders nothing while no feature fills it. */
export function HeaderSlots({ compact = false }: { compact?: boolean }) {
  const slots = usePlaceSlots().filter(s => s.header);
  if (!slots.length) return null;
  // `.hdr-slots` lays out as if absent (display: contents) and lets the bars know a control is there (shell.css).
  return <span className="hdr-slots"><Suspense fallback={null}>{slots.map((s, i) => { const Control = s.header!; return <Control key={i} compact={compact} />; })}</Suspense></span>;
}

/** The figures features add to each coin list row (Radar's columns, Simple's rows), in feature order. */
export function useCoinRowPlaces(): NonNullable<PlaceSlots['coinRow']>[] {
  const slots = usePlaceSlots();
  return useMemo(() => slots.flatMap(s => s.coinRow ? [s.coinRow] : []), [slots]);
}
/** Rows sorted by a feature's figure, highest first; rows without one keep their order, last. */
export function sortByPlace<R>(rows: readonly R[], value: (row: R) => number | undefined): R[] {
  return rows.map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => a.v === undefined ? (b.v === undefined ? a.i - b.i : 1) : b.v === undefined ? -1 : b.v - a.v || a.i - b.i).map(x => x.row);
}
