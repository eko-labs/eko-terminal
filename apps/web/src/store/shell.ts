import { create } from 'zustand';
import { PublicConfigSchema, type Me, type PublicConfig } from '@eko/shared';
import type { Realtime } from '../lib/realtime';
import type { WsState } from '../lib/ws';
interface ShellState {
  realtime: Realtime | null;
  config: PublicConfig | null; me: Me | null; configError: string | null;
  wsState: WsState; delayedSec: number; headBlock: number | null; approvalIds: string[];
}
/**
 * The public config the server put in the page (<script id="eko-config">), so the first render already knows the
 * features, plan and trading state and nothing resizes when /config returns. Null in tests, dev and on a bad payload.
 */
export function inlineConfig(): PublicConfig | null {
  try {
    const text = typeof document === 'undefined' ? null : document.getElementById('eko-config')?.textContent;
    if (!text) return null;
    const parsed = PublicConfigSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export const useShell = create<ShellState>(() => ({ realtime: null, config: inlineConfig(), me: null, configError: null, wsState: 'connecting', delayedSec: 0, headBlock: null, approvalIds: [] }));
