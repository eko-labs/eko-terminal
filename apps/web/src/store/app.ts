import { create } from 'zustand';
import {
  DEFAULT_LAYOUT,
  DEFAULT_PREFERENCES,
  WorkspaceLayoutSchema,
  MeSchema,
  PreferencesSchema,
  type MarketDef,
  type NetworkDef,
  type NetworkId,
  type Order,
  type ParamSpec,
  type Preferences,
  type ProviderInfo,
  type RouteDef,
  type ServerMessage,
  type StrategyMeta,
  type SystemHealth,
  type Ticker,
  type TradingMode,
  type WorkspaceLayout,
} from '@eko/shared';
import { api, fetchParsed } from '../lib/api';
import { socket, type WsState } from '../lib/ws';
import { useShell } from './shell';
import { SETTINGS_COPY } from '../copy/settings';
import { useUi, applyUiMotion } from './ui';

function accountFromMe(me: import('@eko/shared').Me): Account {
  return { id: me.account.id, kind: me.account.wallet ? 'wallet' : 'guest', walletAddress: me.account.wallet?.toLowerCase() ?? null, displayName: null, role: 'user' };
}

export interface ServerConfig {
  version: string;
  dataSource: string;
  simulatedData: boolean;
  liveTradingEnabled: boolean;
  devRoutes: boolean;
  markets: (MarketDef & { routes: { testnet: RouteDef | null; live: RouteDef | null } })[];
  networks: Record<NetworkId, NetworkDef>;
  /** route: 'gateway' → show e.g. "Claude · via PPQ" (via = gateway label); null when not configured. */
  providers: (ProviderInfo & { configured: boolean; defaultModel: string | null; route: 'direct' | 'gateway' | null; via: string | null })[];
  /** AI setup state for onboarding: gateway connected?, which providers can run, spend caps. */
  ai: {
    gateway: { configured: boolean; via: string; baseUrl: string };
    configuredProviders: string[];
    setupCommand: string;
    budget: { dailyUsd: number; maxCallsPerBotHour: number };
  };
  strategies: {
    rules: (StrategyMeta & { params: ParamSpec[] })[];
  };
  aiBudget: { dailyUsd: number; maxCallsPerBotHour: number };
  backtestMethodology: string;
}

export interface Account {
  id: string;
  kind: 'guest' | 'wallet';
  walletAddress: string | null;
  displayName: string | null;
  role: 'user' | 'admin';
}

interface State {
  boot: 'loading' | 'ready' | 'error';
  bootError: string | null;
  config: ServerConfig | null;
  account: Account | null;
  preferences: Preferences;
  layout: WorkspaceLayout;
  tickers: Record<string, Ticker>;
  health: SystemHealth | null;
  wsState: WsState;
  mode: TradingMode;
  orders: Order[];
  portfolioRev: number;
  paletteOpen: boolean;
  helpOpen: boolean;
  toasts: { id: number; kind: 'info' | 'ok' | 'warn' | 'error'; title: string; body?: string; action?: { label: string; run: () => void } }[];

}

interface Actions {
  start(): Promise<void>;
  setLayout(p: Partial<WorkspaceLayout>): void;
  setPreferences(p: Partial<Preferences>): Promise<void>;
  refreshSession(): Promise<void>;
  signOut(): Promise<void>;
  refreshOrders(): Promise<void>;
  setMode(m: TradingMode): void;
  upsertOrder(o: Order): void;
  toast(t: Omit<State['toasts'][number], 'id'>): void;
  dismissToast(id: number): void;
  set(p: Partial<State>): void;
}

const LS_LAYOUT = 'eko.layout';
let layoutTimer: number | null = null;
let toastId = 1;
let sessionRevision = 0;

function readLocalLayout(): Partial<WorkspaceLayout> {
  try {
    return WorkspaceLayoutSchema.partial().parse(JSON.parse(localStorage.getItem(LS_LAYOUT) ?? '{}'));
  } catch {
    return {};
  }
}

export const useApp = create<State & Actions>((set, get) => ({
  boot: 'loading',
  bootError: null,
  config: null,
  account: null,
  preferences: DEFAULT_PREFERENCES,
  layout: { ...DEFAULT_LAYOUT, ...readLocalLayout() },
  tickers: {},
  health: null,
  wsState: 'connecting',
  mode: 'paper',
  orders: [],
  portfolioRev: 0,
  paletteOpen: false,
  helpOpen: false,
  toasts: [],

  set: (p) => set(p),

  async start() {
    try {
      await get().refreshSession();
      const config = await api<ServerConfig>('/api/config');
      const prefs = get().preferences;
      const layout = { ...DEFAULT_LAYOUT, ...readLocalLayout() };
      if (!layout.watchlist.length) layout.watchlist = config.markets.map((m) => m.id);
      set({
        config,
        layout,
        mode: prefs.defaultMode === 'live' ? 'paper' : prefs.defaultMode,
        boot: 'ready',
      });
      applyUiMotion(useUi.getState().reducedMotion);
      socket.on(onMessage);
      socket.onState((s) => set({ wsState: s }));
      socket.onReconnect = () => {
        // Reconcile anything missed while disconnected.
        void get().refreshOrders();
        set({ portfolioRev: get().portfolioRev + 1 });
      };
      socket.connect();
      await get().refreshOrders();
    } catch (err) {
      set({ boot: 'error', bootError: (err as Error).message });
    }
  },

  setLayout(p) {
    const layout = { ...get().layout, ...p };
    set({ layout });
    try {
      localStorage.setItem(LS_LAYOUT, JSON.stringify(layout));
    } catch {
      /* storage unavailable */
    }
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = window.setTimeout(() => {
      void api('/api/layout', { method: 'PUT', body: get().layout }).catch(() => undefined);
    }, 800);
  },

  async setPreferences(p) {
    const revision = sessionRevision, accountId = get().account?.id;
    const prefs = { ...get().preferences, ...p };
    const saved = await fetchParsed('/me/preferences', PreferencesSchema, { method: 'PUT', body: prefs });
    if (revision !== sessionRevision || get().account?.id !== accountId) throw new Error(SETTINGS_COPY.accountChanged);
    set({ preferences: saved });
  },

  async refreshSession() {
    const revision = ++sessionRevision;
    const me = await fetchParsed('/me', MeSchema);
    const prefs = await fetchParsed('/me/preferences', PreferencesSchema);
    if (revision !== sessionRevision) return;
    set({ account: accountFromMe(me), preferences: prefs });
    useShell.setState({ me });
    applyUiMotion(useUi.getState().reducedMotion);
  },

  async signOut() {
    await api('/auth/logout', { method: 'POST' });
    sessionRevision++;
    set({ account: null, preferences: DEFAULT_PREFERENCES, mode: 'paper' });
    useShell.setState({ me: null, approvalIds: [] });
    useShell.getState().realtime?.setSignedIn(false);
    // Logout succeeded even if loading the new anonymous session fails.
    await get().refreshSession().catch(() => undefined);
  },

  async refreshOrders() {
    const r = await api<{ orders: Order[] }>('/api/orders?limit=300').catch(() => ({ orders: [] as Order[] }));
    set({ orders: r.orders });
  },

  setMode(m) {
    set({ mode: m });
  },

  upsertOrder(o) {
    const orders = [o, ...get().orders.filter((x) => x.id !== o.id)].sort((a, b) => b.createdAt - a.createdAt);
    set({ orders });
  },

  toast(t) {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    window.setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 9000 : 5000);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

}));

export function prefersReducedMotion(): boolean {
  const attr = document.documentElement.getAttribute('data-motion');
  if (attr === 'off') return true;
  if (attr === 'on') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function onMessage(m: ServerMessage) {
  const s = useApp.getState();
  switch (m.type) {
    case 'ticker':
      useApp.setState({ tickers: { ...s.tickers, [m.ticker.market]: m.ticker } });
      break;
    case 'health':
      useApp.setState({ health: m.health });
      break;
    case 'order':
      s.upsertOrder(m.order);
      break;
    case 'portfolio':
      useApp.setState({ portfolioRev: s.portfolioRev + 1 });
      break;
    default:
      break;
  }
}

/** Candle stream for charts, kept out of React state for performance. */
type CandleListener = (m: Extract<ServerMessage, { type: 'candle' }>) => void;
const candleListeners = new Set<CandleListener>();
socket.on((m) => {
  if (m.type === 'candle') for (const l of candleListeners) l(m);
});
export function onCandle(l: CandleListener) {
  candleListeners.add(l);
  return () => {
    candleListeners.delete(l);
  };
}
