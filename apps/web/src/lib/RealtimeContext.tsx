import { createContext, useContext } from 'react';
import type { Realtime } from './realtime';
export const RealtimeContext = createContext<Realtime | null>(null);
export const useRealtime = () => useContext(RealtimeContext);
