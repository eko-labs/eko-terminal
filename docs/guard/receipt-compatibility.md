# Guard receipt compatibility (packet 034)

Implements Guard 2.0 §7.3 and Backend §13. This is prepared shadow infrastructure; it does not release scoring, alter a V1 verdict/card/policy result, or submit a transaction.

## Immutable inputs and payloads

`evaluateGuardV2` returns the admitted raw `deterministicInput`, including exact metric strings, statuses, coverage, full cursors, availability, qualification/role/history inputs, configuration versions and the compatibility matrix. Its calculation reference is internal, not a public recorded receipt. Uncaptured shadow journals remain internal and are excluded from the receipt queue.

`GuardVerdictStore.putRevision` requires that input and validates its snapshot/decision hashes. In the transaction, it extends the snapshot with requested route/size/account context, the source manifest and sorted captured source references/dependencies. Acquisition wall times, recording time, execution IDs and receipt metadata are excluded from deterministic identity. Raw evidence is referenced by immutable content hashes; normalized observations preserve exact quantities and unknowns. The full revision key includes chain, token, block hash/full cursor, availability, mode, schema/method versions, configuration/code/service/profile/calibration hashes, manifest, source revision, context and snapshot hash.

The receipt ID is allocated before serializing `GuardReceiptPayload` with `jcs-rfc8785/v1`. The payload retains the raw snapshot, full revision key, assessment decision (including snapshot/decision hashes), actual first recording time, mode and supersession. It contains no recursive receipt, payload hash, proof, registry root, batch ID or anchor transaction. `payloadHash` hashes these original JCS bytes, never a rounded or newly formatted card. `evidenceRoot` remains the explicitly tagged source-ID digest from the shadow scorer; it is not the registry Merkle root.

Same-key recomputation keeps the first receipt ID, bytes and recording time, and appends an execution-run record. A different decision for identical inputs/code is rejected. Same-boundary/context corrections append a receipt and supersession event, including corrections to orphaned records; a new block starts a separate assessment. Existing records, including pre-034 shadow records and all V1 payloads/levels, are never rewritten or backfilled with a fabricated public payload.

## Recording, batching and historical retrieval

`GuardReceiptStore.get(receiptId)` retrieves the permanent original JSON and canonical bytes, a recorded/anchored reference, and separate verdict status events. Unknown IDs return `null`. The receipts adapter owns payload and anchor writes; verdict creation records its envelope in the same transaction. Original verification remains possible after supersession or source reorg. An anchor proves inclusion, not the accuracy of an assessment.

`prepareBatch(now)` uses completed 300-second boundaries and includes unanchored backlog. Its root/proofs are preparation artifacts, not public anchored references or batch IDs. The unchanged leaf is:

```text
itemId = keccak256(UTF8(Receipt.id))
leaf = keccak256(keccak256(abi.encode(uint8(kind), bytes32(itemId), bytes32(payloadHash))))
kind: verdict=0, forecast=1, harness_private=2
```

After a separate committer submits the prepared root, `recordAnchor` reads the successful canonical transaction through an injected configured-chain reader. It requires exactly one matching `BatchCommitted` from the configured registry, with the prepared root and leaf count, and stores its real sequence ID, transaction, committer, block hash and log index. It rejects wrong-chain, reverted, orphaned, wrong-emitter and mismatched events. No signer or scheduled submission is added here. V1 pending-anchor references retain their original shape.

Call `refreshAnchors` before serving current anchor status and before preparing a batch after a reorg. It checks committed block hashes, appends orphan events and requeues orphaned items without changing their bytes. A reader error/missing canonical header is an error, not evidence of orphaning. Historical anchor facts remain stored separately. The pure browser `receiptVerifier` verifies original payload/JCS/inner hashes and inclusion against a root obtained independently from the configured registry; trusting an API-supplied root alone does not authenticate an anchor. Public HTTP receipt routes and a running committer are not activated by this packet.

Public payloads, proofs, normalized summaries and digests persist indefinitely. Full simulation traces have a separate 2,592,000-second retention window from trace recording, not from a later receipt retrieval/recomputation. Receipt retrieval must still succeed when a full trace expires. A trace retrieval adapter must explicitly report the absent **full trace** as expired (or unavailable if missing before expiry), retain its content digest/object reference and expiry, and return retained normalized replay inputs/checkpoints separately. A digest cannot regenerate the expired bytes. Large-object retrieval must verify content addressing and internal retrieval proofs; a mutable URL is not a replacement. This packet does not add a trace/object transport or manufacture traces from digests. Reproduction also requires the pinned code/config/dataset/review/calibration artifacts; receipt inclusion alone does not supply those artifacts.

## Shared synthetic vectors

`packages/shared/test/fixtures/receipts/v1.json` is unchanged. `guard-v2.json` adds a mixed batch of legacy verdict/forecast/private domains and raw V2 assessments: 9.999 versus 10 percent (both display 10.00), observed zero versus unknown, and a corrected same-block fork superseding the original. Shared TS, browser-entry-point tests, the TS batching adapter and Foundry consume these frozen JSON vectors. These are synthetic encoding/lifecycle tests, not measured chain coverage, accuracy, calibration or release evidence.

Explicit regeneration (no ports or network):

```sh
pnpm --config.verifyDepsBeforeRun=false --filter @eko/db exec node --import tsx scripts/generate-guard-receipt-fixtures.ts
```

Main owns 0117_pons_progress; the Guard shadow journal is 0119_guard_shadow. Receipt storage stays at 0118 and applies after 0116 revisions, before the independent 0119 journal. Guard source storage stays at 0115.
