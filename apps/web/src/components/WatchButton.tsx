import { useEffect } from 'react';
import type { WatchBody } from '@eko/shared';
import { useWatch, watchKey } from '../store/watch';
import { useShell } from '../store/shell';
import { useApp } from '../store/app';
export function ConnectWatch() { return <div className="connect-card"><p>Connect and verify your wallet to manage watches and notifications.</p><button className="btn" onClick={() => window.dispatchEvent(new Event('eko:open-wallet'))}>Connect wallet</button></div>; }
/** Shared by coin, Radar and the bags screen when its packet lands. */
export function WatchButton({ kind = 'coin', target }: WatchBody) {
  const owner = useWatch(s => s.owner), watched = useWatch(s => s.items.some(w => watchKey(w) === watchKey({ kind, target }))), busy = useWatch(s => s.pending.includes(watchKey({ kind, target }))), crews = useShell(s => !!s.config?.flags.rug_ring_radar);
  if (kind === 'crew' && !crews) return null;
  return <button className="btn" aria-pressed={watched} disabled={busy} onClick={() => {
    if (!owner) { window.dispatchEvent(new Event('eko:open-wallet')); return; }
    void useWatch.getState().change({ kind, target }, watched, crews).catch(() => useApp.getState().toast({ kind: 'error', title: 'Could not update watch. Try again.' }));
  }}>{busy ? 'Saving watch…' : watched ? 'Watching' : 'Watch'}</button>;
}
export function WatchRuntime({ owner }: { owner: string | null }) {
  const rt = useShell(s => s.realtime);
  useEffect(() => {
    useWatch.getState().setOwner(owner);
    if (!owner) return;
    void useWatch.getState().refresh().catch(() => {});
    void useWatch.getState().resyncAlerts().catch(() => {});
    return () => useWatch.getState().setOwner(null);
  }, [owner]);
  useEffect(() => {
    if (!rt || !owner) return;
    return rt.subscribeBatch('alerts', events => useWatch.getState().receive(events), async () => {
      const [, seq] = await Promise.all([useWatch.getState().refresh(), useWatch.getState().resyncAlerts()]); return seq;
    });
  }, [rt, owner]);
  return null;
}
