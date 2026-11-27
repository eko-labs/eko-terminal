import { create } from 'zustand';
import { z } from 'zod';
import { AgentSchema } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
import { refreshNav } from '../../components/views';

const AgentsResponse = z.object({ agents: z.array(AgentSchema) });

/**
 * Mission Control in Simple's menu: hidden, as everything a beginner does not need is, except for an owner who already
 * runs agents, who must still reach them. Read once per signed-in wallet while Simple is shown (GET /agents); signed
 * out, or a wallet with no live agent, keeps the menu as it is.
 */
interface State { wallet: string | null; has: boolean }
export const useOwnerAgents = create<State>(() => ({ wallet: null, has: false }));

function set(next: State) {
  const s = useOwnerAgents.getState();
  if (s.wallet === next.wallet && s.has === next.has) return;
  useOwnerAgents.setState(next);
  if (s.has !== next.has) refreshNav();
}

/** Whether this wallet has an agent that is not disconnected (read once per wallet; a failed read shows nothing). */
export async function readOwnerAgents(wallet: string | null, signal?: AbortSignal) {
  if (!wallet) { set({ wallet: null, has: false }); return; }
  if (useOwnerAgents.getState().wallet === wallet) return;
  try {
    const { agents } = await fetchParsed('/agents', AgentsResponse, { signal });
    if (!signal?.aborted) set({ wallet, has: agents.some((a) => a.status !== 'disconnected') });
  } catch { if (!signal?.aborted) set({ wallet, has: false }); }
}

/** Simple's menu keeps Mission Control only for an owner with agents. */
export const missionInMenu = () => useOwnerAgents.getState().has;
