export const REVIEW_COPY = {
  title: 'Blinded evidence review', inactive: 'Internal review · Guard V2 remains shadow/inactive. Human judgments do not change orders.',
  blinded: 'Blinded: points, levels, allegations and independent answers remain hidden until your first submission on this revision.',
  independent: 'Submit independently using pinned evidence. Unresolved is a valid judgment. Original submissions and disagreements remain in history.',
  fixture: 'Synthetic fixture · no measured chain validation or human sign-off', measured: 'Measured snapshot · review still required',
  unavailable: 'Review unavailable. A signed-in session and an explicit case assignment are required.', invalid: 'Invalid review revision ID.',
  loading: 'Loading assigned review…', retry: 'Retry', export: 'Download immutable export', exportNote: 'Export preserves the server content hash and your role’s visibility for every revision.',
  plotMissing: 'Plot unavailable: supported timestamp and return pairs were not supplied. Raw facts remain below.',
  plotNote: 'Each point is one supplied panel at its pinned timestamp. Returns are percentages; no interpolation or causal inference.',
  parity: 'Matched-tool parity is unmeasured here. Exact comparator endpoint, time, route, size, supply convention and coverage require separately acquired snapshots.',
  absent: 'Unknown · panel not supplied in this pinned revision', unknown: 'Unknown', replay_invalid: 'Replay invalid · no valid intervention conclusion', supported: 'Supported',
  submit: 'Submit independent judgment', revise: 'Append judgment revision', adjudicate: 'Append adjudication', pending: 'Waiting for both independent submissions before adjudication.',
  evaluator: 'Evaluator access · read/export only', rationale: 'Evidence rationale', evidence: 'Pinned evidence references', version: 'Label/method version',
  required: 'Select evidence and write a rationale before submitting.', saved: 'Immutable submission saved.', failure: 'Submission or refresh failed. Retry to read the persisted state before resubmitting.',
  reveal: 'Revealed assessments · calibration candidate', alleged: 'Alleged incident labels · not established findings', history: 'Independent label and adjudication history',
  pins: 'Pinned provenance', context: 'Snapshot and execution context', guidance: 'Review questions', noHistory: 'No visible judgments yet.',
  machine: 'Machine outcome · separate from retrospective responsibility', adjudication: 'Adjudication', evidenceUnavailable: 'No linked panel supplied; inspect the immutable evidence manifest.',
} as const;
export const REVIEW_PANELS = {
  role: 'Roles', holding: 'Current original and descendant bags', funding: 'Funding and recycled capital', transfer: 'Transfers and lot origin', sale: 'Who sells now',
  exit: 'Exit for this account and size', control: 'Effective seller control', coverage: 'Coverage, source freshness and excluded mass', intervention: 'Intervention',
  real_buyer: 'Real outside buyers', recovery: 'Old failure and current recovery', identity_provenance: 'Identity and promotion provenance',
} as const;
export const REVIEW_PROMPTS = [
  'Who holds original and descendant bags now?', 'Who sells now, and what establishes seller control?',
  'What can this account and size exit on the pinned route?', 'Is audience independence established or unknown?',
  'Which capital paths recycle?', 'What changed within the outcome horizon?', 'Did an earlier failure recover, and what remains unresolved?',
  'What establishes identity/promotion provenance, source freshness and excluded mass?',
] as const;
export const REVIEW_QUESTIONS = {
  factsAndRoles: 'Are facts and economic roles supported?', coverage: 'Is applicable coverage complete?', buyerHarm: 'Was real buyer harm observed?',
  currentMechanism: 'What is the current risk mechanism?', retrospectiveResponsibility: 'Is retrospective responsibility established?',
  sellerControl: 'Who controls the seller?', sellerOrigin: 'What is the sold lot origin?', withdrawalMigration: 'Was withdrawal harmful or migration benign?',
  outcomeMaturity: 'Is the outcome mature?', reasonSupport: 'Are the reasons supported by pinned evidence?',
} as const;
