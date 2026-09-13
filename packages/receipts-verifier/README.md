# Browser receipts verifier

Prepared workspace entry point for public verifier packaging (BACKEND §13). This package remains private and has not been published. Its source exports the pure V1/V2 codec, the published ReceiptsRegistry ABI and `verifyReceipt` with three readable stages.

Consumers supply a separately published, verified registry address and a keyless viem public client for chain 4663. Do not take the trusted registry from the receipt or its API response. The web integration keeps verification unavailable while the deployment address is unresolved. Reads use the public chain RPC directly, with no API verification verdict, wallet connection, signing, user key or server secret.

`verifyReceipt(lookup, registry, reader)` validates JCS canonical bytes, payload hash and the double-hashed StandardMerkleTree leaf, folds sorted sibling hashes, and checks the historical registry batch plus the exact successful transaction event and canonical block. Pending items do no chain reads. Unrevealed public or private items return `commitment`, never a verified-payload claim.

The checked-in ABI is compared to the chain package's published ABI in tests. Shared Guard-owned V1/V2 fixtures are consumed unchanged; fixture passes are not live evidence.

Reproduce with `pnpm --filter @eko/receipts-verifier typecheck` and `pnpm --filter @eko/receipts-verifier test`. A separately authorized release must package the workspace source and its shared dependency, select supported distribution targets, review the deployed registry pin and publish the resulting artifacts. Nothing here authorizes publication or changes Guard rules.
