import { z } from 'zod';

// BACKEND §21.4: keep stages and names in sync with the frozen contract.
export const FLAG_STAGES = {
  D0:       ['approvals', 'mission_kill', 'policy_editor', 'unchecked_orders', 'loop_lab', 'deep_research', 'perps_panel',
             'summon_x', 'beat_the_swarm', 'clear_badge', 'burn_board', 'onchain_guardrails', 'packs_chatgpt_openclaw'],
  'D0+1':   ['tiers_active', 'trial', 'referrals'],
  'Drop 1': ['afi', 'x402_api', 'agent_annotations', 'lenses', 'agent_flow_tools'],
  'Drop 2': ['rug_ring_radar', 'leaderboards'],
  'Drop 3': ['arena'],
  'Drop 4': ['desk_live', 'ask_the_swarm'],
  'Drop 5': ['agent_launcher'],
  'Drop 6': ['loop_lab_pro', 'stocks_lane'],
  'Drop 7': ['eko_score', 'eko_inside'],
  'Drop 8': ['chain_base'],
  'Drop 9': ['institutional_pack', 'marketplace', 'eko_agent'],
} as const;
export type FlagName = (typeof FLAG_STAGES)[keyof typeof FLAG_STAGES][number];
export const FLAG_NAMES = Object.values(FLAG_STAGES).flat() as [FlagName, ...FlagName[]];
export const FlagNameSchema = z.enum(FLAG_NAMES);
// Enum records require every flag and reject unknown keys (including ops switches).
export const FlagsSchema = z.record(FlagNameSchema, z.boolean());
export type Flags = z.infer<typeof FlagsSchema>;

export type OpsSwitch = 'trading_live' | 'swarm_ranking';
export const OpsSwitchSchema = z.enum(['trading_live', 'swarm_ranking']);
