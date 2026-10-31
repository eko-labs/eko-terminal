import { create } from 'zustand';
import type { Me, PublicConfig } from '@eko/shared';
import type { Realtime } from '../lib/realtime';
import type { WsState } from '../lib/ws';
interface ShellState {
  realtime: Realtime | null;
  config: PublicConfig | null; me: Me | null; configError: string | null;
  wsState: WsState; delayedSec: number; headBlock: number | null; approvalIds: string[];
}
export const useShell = create<ShellState>(() => ({ realtime: null, config: null, me: null, configError: null, wsState: 'connecting', delayedSec: 0, headBlock: null, approvalIds: [] }));
