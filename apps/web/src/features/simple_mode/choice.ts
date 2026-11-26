import { create } from 'zustand';
import { isLens, isSort, type Lens, type SortBy } from './trench';

/**
 * Simple or Full: which view of EKO this browser shows. Kept in localStorage, read and written inside try/catch (private
 * windows and blocked storage simply start in Simple each time). With nothing saved, the site starts in Simple.
 */
export type ViewChoice = 'simple' | 'full';
export const CHOICE_KEY = 'eko.view';
const ONLY_OK_KEY = 'eko.view.onlyOk';
const WALKED_KEY = 'eko.view.walked';
const LENS_KEY = 'eko.view.lens', SORT_KEY = 'eko.view.sort';
export type Walk = 'list' | 'coin';

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}
function read(key: string): string | null {
  try { return storage()?.getItem(key) ?? null; } catch { return null; }
}
function write(key: string, value: string) {
  try { storage()?.setItem(key, value); } catch { /* storage unavailable: the choice lasts this visit */ }
}
/** The saved choice, or Simple when there is none (a first visit) or it cannot be read. */
export function savedChoice(value: string | null): ViewChoice { return value === 'full' ? 'full' : 'simple'; }
export function savedWalks(value: string | null): Walk[] {
  try { const v: unknown = JSON.parse(value ?? '[]'); return Array.isArray(v) ? v.filter((w): w is Walk => w === 'list' || w === 'coin') : []; } catch { return []; }
}

interface State {
  choice: ViewChoice;
  /** The coins list shows only coins that look OK. */
  onlyOk: boolean;
  /** The coins list's quick filter and sort (trench.ts). */
  lens: Lens;
  sort: SortBy;
  setLens(lens: Lens): void;
  setSort(sort: SortBy): void;
  /** Walkthroughs already shown on this device. */
  walked: Walk[];
  /** The walkthrough running now, if any. */
  walk: Walk | null;
  /** Full was just opened from the walkthrough's "Show me Full": it shows one card on the switch (Walkthrough.tsx FullIntro). */
  tryFull: boolean;
  choose(choice: ViewChoice): void;
  setOnlyOk(onlyOk: boolean): void;
  startWalk(walk: Walk): void;
  endWalk(): void;
}
export const useSimple = create<State>((set, get) => ({
  choice: savedChoice(read(CHOICE_KEY)),
  onlyOk: read(ONLY_OK_KEY) === '1',
  lens: (v => (isLens(v) ? v : 'all'))(read(LENS_KEY)),
  sort: (v => (isSort(v) ? v : 'hot'))(read(SORT_KEY)),
  setLens: (lens) => { write(LENS_KEY, lens); set({ lens }); },
  setSort: (sort) => { write(SORT_KEY, sort); set({ sort }); },
  walked: savedWalks(read(WALKED_KEY)),
  walk: null,
  tryFull: false,
  choose: (choice) => { write(CHOICE_KEY, choice); set({ choice, ...(choice === 'full' ? { walk: null } : {}) }); },
  setOnlyOk: (onlyOk) => { write(ONLY_OK_KEY, onlyOk ? '1' : '0'); set({ onlyOk }); },
  startWalk: (walk) => set({ walk }),
  endWalk: () => {
    const { walk, walked } = get();
    if (!walk) return;
    const next = walked.includes(walk) ? walked : [...walked, walk];
    write(WALKED_KEY, JSON.stringify(next));
    set({ walk: null, walked: next });
  },
}));
