import { ResearchJobSchema } from '@eko/shared';
import { createResearchJob } from '../fixtures';

/** Completed sample notes for the D0 list; ids match their detail links. */
export function createResearchNotes() {
  return [
    { id: 'research-1', summary: 'Deployer and liquidity observations' },
    { id: 'research-2', summary: 'Holder distribution and agent inflow' },
  ].map(({ id, summary }) => {
    const job = createResearchJob();
    return ResearchJobSchema.parse({ ...job, id, status: 'done', note: { ...job.note!, summary: { text: summary, truncated: false, flags: [] } } });
  });
}
