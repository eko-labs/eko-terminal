import { create } from 'zustand';

/** UI-only state for the workspace chrome. Server-backed data lives in store/app.ts. */

export type BottomTab = 'positions' | 'activity';
/** What the top of the phone layout shows ('none' = the chart). The Trade sheet is always docked below. */
export type MobileSheet = 'none' | 'markets' | 'positions';

interface Persisted {
  density: 'comfortable' | 'compact';
  reducedMotion: 'system' | 'on' | 'off';
  humanMarkers: boolean;
  riskMode: 'safe' | 'balanced' | 'degen';
  bottomTab: BottomTab;
  /** The Buy/Sell preset the user picked (USD). Falls back to a preset from preferences when it's gone. */
  amountUsd: number | null;
}

interface Session {
  mobileSheet: MobileSheet;
}

interface UiState extends Persisted, Session {
  set(p: Partial<Persisted & Session>): void;
}

const LS = 'eko.ui';
const DEFAULTS: Persisted = { density: 'comfortable', reducedMotion: 'system', humanMarkers: false, riskMode: 'balanced', bottomTab: 'positions', amountUsd: null };

function read(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(LS) ?? '{}') as Partial<Record<keyof Persisted, unknown>>;
    return {
      reducedMotion: raw.reducedMotion === 'on' || raw.reducedMotion === 'off' ? raw.reducedMotion : 'system',
      humanMarkers: raw.humanMarkers === true,
      density: raw.density === 'compact' ? 'compact' : 'comfortable',
      riskMode: raw.riskMode === 'safe' || raw.riskMode === 'degen' ? raw.riskMode : 'balanced',
      bottomTab: raw.bottomTab === 'activity' ? 'activity' : 'positions',
      amountUsd: typeof raw.amountUsd === 'number' && raw.amountUsd > 0 ? raw.amountUsd : null,
    };
  } catch {
    return DEFAULTS;
  }
}

function write(s: Persisted) {
  try {
    const { bottomTab, amountUsd, riskMode, density, reducedMotion, humanMarkers } = s;
    localStorage.setItem(LS, JSON.stringify({ bottomTab, amountUsd, riskMode, density, reducedMotion, humanMarkers }));
  } catch {
    /* storage unavailable */
  }
}

export const useUi = create<UiState>((set, get) => ({
  ...read(),
  mobileSheet: 'none',
  set(p) {
    set(p);
    write(get());
    applyUiMotion(get().reducedMotion);
  },
}));

// Rewrite the persisted slice once so obsolete preferences are dropped on startup.
write(useUi.getState());

export function applyUiMotion(pref: Persisted['reducedMotion']) {
  if (typeof document === 'undefined') return;
  if (pref === 'system') document.documentElement.removeAttribute('data-motion');
  else document.documentElement.setAttribute('data-motion', pref === 'on' ? 'off' : 'on');
}
applyUiMotion(useUi.getState().reducedMotion);
