import { create } from 'zustand';
import { z } from 'zod';
import { AddressSchema, AlertSchema, AlertSettingsSchema, WatchBodySchema, type Alert, type AlertSettings, type WatchBody, type WsEvent } from '@eko/shared';
import { useApp } from './app';
import { api, fetchParsed, type ApiOptions } from '../lib/api';

const WatchList = z.object({ items: z.array(WatchBodySchema) });
// TODO(spec): Use task 114's private /alerts cursor envelope until CA-28 freezes a history contract.
const History = z.object({ rows: z.array(AlertSchema), cursor: z.number().int().nonnegative().nullable(), seq: z.number().int().nonnegative() });
export const watchKey = (w: WatchBody) => `${w.kind}:${w.kind === 'crew' ? w.target : w.target.toLowerCase()}`;
export function watchTarget(body: WatchBody, crews = false): WatchBody {
  const parsed = WatchBodySchema.parse(body);
  if (parsed.kind === 'crew') { if (!crews) throw new Error('Crew watches are unavailable.'); return parsed; }
  return { ...parsed, target: AddressSchema.parse(parsed.target.trim()).toLowerCase() };
}
export interface WatchClient {
  parse<T>(path: string, schema: z.ZodType<T>, opts?: ApiOptions): Promise<T>;
  request(path: string, opts?: ApiOptions): Promise<unknown>;
}
interface WatchState {
  owner: string | null; items: WatchBody[]; settings: AlertSettings | null; alerts: Alert[];
  loading: boolean; error: string | null; alertError: string | null; pending: string[]; saving: boolean;
  setOwner(owner: string | null): void; refresh(): Promise<void>; change(body: WatchBody, remove: boolean, crews?: boolean): Promise<void>;
  save(settings: AlertSettings): Promise<void>; resyncAlerts(): Promise<number | void>; receive(events: WsEvent<'alerts'>[]): void;
}
export function createWatchStore(client: WatchClient, notify: (alert: Alert) => void = () => {}) {
  let generation = 0, watchRevision = 0, settingsRevision = 0, historyReady = false;
  let cursor = 0, historyJob: Promise<number | void> | null = null;
  const seen = new Set<string>();
  return create<WatchState>((set, get) => {
    const current = (g: number) => generation === g && !!get().owner;
    const merge = (rows: Alert[], toast: boolean) => {
      const fresh = rows.filter(a => !seen.has(a.id));
      rows.forEach(a => seen.add(a.id));
      while (seen.size > 1000) seen.delete(seen.values().next().value!);
      set(s => ({ alerts: [...new Map([...s.alerts, ...rows].map(a => [a.id, a])).values()].sort((a,b) => b.ts.localeCompare(a.ts)).slice(0, 100) }));
      if (toast) fresh.forEach(notify);
    };
    return {
      owner: null, items: [], settings: null, alerts: [], loading: false, error: null, alertError: null, pending: [], saving: false,
      setOwner(owner) {
        if (get().owner === owner) return;
        generation++; watchRevision++; settingsRevision++; cursor = 0; historyReady = false; historyJob = null; seen.clear();
        set({ owner, items: [], settings: null, alerts: [], pending: [], saving: false, loading: false, error: null, alertError: null });
      },
      async refresh() {
        if (!get().owner) return;
        const g = generation, wr = watchRevision, sr = settingsRevision;
        set({ loading: true, error: null });
        try {
          const [w, settings] = await Promise.all([client.parse('/watch', WatchList), client.parse('/alerts/settings', AlertSettingsSchema)]);
          if (current(g)) set({ ...(wr === watchRevision ? { items: w.items } : {}), ...(sr === settingsRevision ? { settings } : {}), loading: false });
        } catch (e) { if (current(g)) { set({ loading: false, error: 'Could not load watches and notification settings.' }); } throw e; }
      },
      async change(body, remove, crews = false) {
        if (!get().owner) throw new Error('Connect and verify your wallet to manage watches.');
        const item = watchTarget(body, crews), key = watchKey(item);
        if (get().pending.includes(key)) return;
        const g = generation, before = get().items, previous = before.find(w => watchKey(w) === key);
        watchRevision++;
        set({ pending: [...get().pending, key], error: null, items: remove ? before.filter(w => watchKey(w) !== key) : previous ? before : [...before, item] });
        try {
          if (remove) await client.request('/watch', { method: 'DELETE', body: item });
          else await client.parse('/watch', WatchBodySchema, { method: 'POST', body: item });
        } catch (e) {
          if (current(g)) set(s => ({ items: [...s.items.filter(w => watchKey(w) !== key), ...(previous ? [previous] : [])], error: 'Could not update watch. Your previous watch was restored.' }));
          throw e;
        } finally { if (current(g)) { watchRevision++; set(s => ({ pending: s.pending.filter(k => k !== key) })); } }
      },
      async save(settings) {
        if (!get().owner || get().saving) return;
        const g = generation; settingsRevision++; set({ saving: true });
        try { const saved = await client.parse('/alerts/settings', AlertSettingsSchema, { method: 'PUT', body: AlertSettingsSchema.parse(settings) }); if (current(g)) set({ settings: saved }); }
        finally { if (current(g)) { settingsRevision++; set({ saving: false }); } }
      },
      resyncAlerts() {
        if (!get().owner) return Promise.resolve();
        if (historyJob) return historyJob;
        const g = generation, toast = historyReady;
        const job = (async () => {
          try {
            let after = cursor;
            for (;;) {
              const page = await client.parse(`/alerts?after=${after}`, History);
              if (!current(g)) return;
              merge(page.rows, toast); cursor = Math.max(cursor, page.seq);
              if (page.cursor === null) break;
              if (page.cursor <= after) throw new Error('Invalid alert cursor');
              after = page.cursor;
            }
            historyReady = true; set({ alertError: null }); return cursor;
          } catch (e) { if (current(g)) set({ alertError: 'Could not load alerts. Retry to recover missed notifications.' }); throw e; }
          finally { if (current(g)) historyJob = null; }
        })();
        historyJob = job; return job;
      },
      receive(events) {
        if (!get().owner) return;
        merge(events.filter(e => e.kind === 'alert').map(e => e.data as Alert), true);
      },
    };
  });
}
export const useWatch = createWatchStore({ parse: fetchParsed, request: api }, () => {
  // Notifications contain only first-party kind labels; the drawer renders all source text as UntrustedText.
  useApp.getState().toast({ kind: 'info', title: 'New watch alert', action: { label: 'View alerts', run: () => window.dispatchEvent(new Event('eko:open-alerts')) } });
});
