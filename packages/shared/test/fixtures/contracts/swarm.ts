// Synthetic structured votes, not provider output or calibration evidence.
const hash = `0x${'a'.repeat(64)}`;
const exit = { tp_pct: 50, sl_pct: 20, max_hold_min: 10 };
const vote = { persona_id: 'sniper', action: 'ape', size_bucket: 's', exit, confidence: 0.7 };
export const swarmSamples = {
  SwarmSnapshotHash: hash,
  SwarmBlock: 1000,
  PersonaId: 'sniper',
  PersonaExit: exit,
  PersonaVote: vote,
  VoteBatch: { snapshot_hash: hash, as_of_block: 1000, votes: [vote] },
};
