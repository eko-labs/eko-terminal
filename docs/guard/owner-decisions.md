# Owner decisions

These are resource and human-staffing choices. The level names, two required-check tiers, Safe Elevated denial, unconditional High denial and own-side history rule are already settled.

| Question | Recommended answer | Build assumption until answered |
|---|---|---|
| Approve the incremental data budget and, if needed, a verified native-history source? | Approve $1/day Guard RPC enrichment and $10 initial pilot/backfill, separate from existing indexing; checkpoint at 250,000 nominal request units. Approve any indexed-source subscription separately only after successful external/internal interval-coverage tests and a concrete price/cap. | Use existing data and local fixtures/shadow work. Start no new paid job or subscription. Funding/history gaps stay named; critical gaps deny all buys, lower-tier gaps floor the level at Elevated. No full-chain native scan. See [§8](guard-2.0.md#8-data-requirements-achievable-coverage-and-cost). |
| Who provides the independent reviews, adjudication and release sign-off? | Assign two independent chain-literate reviewers, an adjudicator for disagreements, and an accountable release sign-off role. The rule author cannot be the sole independent signer. | Build the blinded workflow and resumable runners. Human labels and sign-off remain pending; do not invent judgments or claim release gates passed. See [§9.3](guard-2.0.md#93-human-set-sampling-and-comparator-questions). |

No new preference question is needed for candidate thresholds, denominators, windows or packet order. Their starting definitions and acceptance methods are specified in the document. Actual deployment is a separate authorized release action after the gates pass.
