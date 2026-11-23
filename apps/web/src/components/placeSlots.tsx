import { Suspense, useMemo } from 'react';
import type { Flags } from '@eko/shared';
import { FEATURES, type PlaceSlots } from '../features';
import { useShell } from '../store/shell';

/**
 * Places outside the coin page that post-launch features (features.ts `places`) can fill: tools next to a launch filter
 * being edited. A place shows only while its feature's flag is on; with none on, these render nothing and the page is
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
