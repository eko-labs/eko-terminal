import type { ScoreboardResponse } from '../../../src/contracts/scoreboard.js';

export const scoreboardSamples = {
  ScoreboardResponse: {
    rows: [], cursor: null, snapshot: '0', counters: { refused: null, missed: null, since: null },
    availability: {
      refused: { status: 'unavailable', reason: 'monitoring_missing' },
      missed: { status: 'unavailable', reason: 'monitoring_missing' },
      grades: { status: 'unavailable', reason: 'outcomes_unaccepted' },
      forecasts: { status: 'unavailable', reason: 'forecast_dependency' },
      cohort: { status: 'unavailable', reason: 'outcomes_unaccepted' },
      milestones: { status: 'unavailable', reason: 'd0_gated' },
    },
  } satisfies ScoreboardResponse,
};
