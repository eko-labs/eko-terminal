import { useEffect, useState } from 'react';
import type { WsState } from './ws';

/** How long a dropped live link may take to come back before the page calls its data stale (a tab returning from the
 *  background, a deploy, a network blip all reconnect within a few seconds). */
export const RECONNECT_GRACE_MS = 8000;

/** True while the live link is down but only briefly: say "connecting", not "stale". */
export function useReconnecting(ws: WsState): boolean {
  const [downSince, setDownSince] = useState<number | null>(() => (ws === 'open' ? null : Date.now()));
  const [, tick] = useState(0);
  useEffect(() => {
    if (ws === 'open') { setDownSince(null); return; }
    const since = downSince ?? Date.now();
    if (downSince === null) setDownSince(since);
    const left = since + RECONNECT_GRACE_MS - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick(n => n + 1), left);
    return () => clearTimeout(t);
  }, [ws, downSince]);
  return ws !== 'open' && downSince !== null && Date.now() - downSince < RECONNECT_GRACE_MS;
}
