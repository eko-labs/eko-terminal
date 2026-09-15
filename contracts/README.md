# ReceiptsRegistry

The D0 registry stores write-once receipt roots and assigns sequential batch ids.
It implements BACKEND §14.2 exactly. Leaves and proofs follow §13's shared fixture.
Solidity 0.8.26, Cancun, optimizer 10,000 runs, OpenZeppelin 5.6.1 and forge-std
v1.16.2 are already pinned; `foundry.toml` keeps builds offline and explicitly
sets `via_ir = false`, `bytecode_hash = "ipfs"` and `cbor_metadata = true`.
The release toolchain is Foundry v1.7.1 (also pinned in CI).

From the repository root:

```sh
pnpm --filter @eko/contracts build
pnpm --filter @eko/contracts test
pnpm --filter @eko/contracts abi:export
pnpm --filter @eko/contracts coverage
```

The root `pnpm test` includes this workspace. When `forge` is absent, only the
Foundry step skips with a clear message locally, but fails when `CI` is set;
build failures and failed tests propagate.
The ABI export builds first and writes only the ABI (no build metadata or machine
paths) to `packages/chain/abi/eko/ReceiptsRegistry.json`. Chain tests derive receipt
event topics from that ABI; do not hand-type topic hashes.

From `contracts/`, run `forge snapshot` to refresh `.gas-snapshot`, and
`forge test --match-contract ReceiptsRegistryGasTest --gas-report` for call gas.
`forge coverage --report summary` reports registry coverage. The complete
[review gate](review/README.md) remains required before D0.

## Offline mutation measurement

```sh
pnpm --filter @eko/contracts mutation
# Or, from the repository root:
node contracts/scripts/mutate.mjs
```

The dependency-free Node 22 runner copies the Foundry project, installed
OpenZeppelin sources, forge-std and receipt fixtures into a temporary directory.
It mutates only authored `src/*.sol` sources, one edit at a time, using the same
`foundry.toml` and cached solc 0.8.26 with `--offline`. The full Forge suite runs
with seed `0x1`, two threads and the existing fuzz/invariant limits. RPC is unset,
so the optional hosted fork test skips. The scratch directory is removed on exit.

Results replace [release/mutation.json](release/mutation.json). Compilation
failures and rejected visibility changes earn no kill credit. Exact counts,
operator scope, environment and every survivor's disposition are in
[the mutation report](../docs/security/MUTATION.md). The command exits nonzero
for a failing baseline, an infrastructure error, any unresolved survivor or a
score below 80%. It takes several minutes and is intentionally separate from
the default `pnpm test` gate. `--list` enumerates candidates without running Forge.

## Hardware deployment

Provide `RPC_HTTP_URL`, `RECEIPTS_OWNER` and `RECEIPTS_COMMITTER` through the
operator's environment. The owner is cold hardware; the committer is a separate
hot key holding gas only (§18). The script rejects zero addresses and equal roles.
No private key or mnemonic is read by the script. The hardware deployer signs
using the command in the registry-owner handoff below.

The script logs the deployed address and simulation block; confirm the mined block
from the broadcast transaction receipt. Confirm owner/committer on-chain, publish
the deployment record and regenerate the ABI before configuring consumers.
Publish disclosed public role addresses in the accepted deployment manifest;
never commit signer material or RPC credentials.

## Registry-owner handoff before mainnet

BACKEND §§13, 14.2 and 18 require a cold owner, a separate gas-only hot committer
and `Ownable2Step`. The pre-mainnet plan is a **2-of-3 Safe multisig** on chain
4663, with three independent hardware signers, separate seeds and offline
recovery copies. Two approvals prevent one compromised signer from acting;
three signers allow one lost device to be replaced without losing the quorum.
Signers are role holders; no personal identities belong in the public record.

// TODO(spec): BACKEND §18 proposes a single hardware device for the registry
// owner but does not decide a registry multisig threshold or timelock. This
// plan replaces that single owner key with 2-of-3 hardware custody before
// mainnet; chain-4663 Safe deployment/bytecode and signer recovery need release
// verification. It is a plan, not evidence that custody has changed.

**Timelock decision: none; on-chain delay is 0 seconds.** The Safe directly owns
the registry, with no bypass module or alternate single-signer execution path.
The registry has no treasury, upgrade, root-edit or user-execution powers. A
mandatory delay on `setCommitter` would extend a compromised hot key's ability
to append junk roots. Two hardware approvals therefore apply to both routine
owner actions and immediate incident revocation. For routine ownership or Safe
configuration changes, publish the proposed destination/configuration and allow
a 24-hour operational review before signing. That notice is a process rule,
not an enforced timelock; the 2-of-3 threshold remains the on-chain control.
If future owner powers can move funds or upgrade code, revisit an enforced
timelock and a narrowly bounded emergency revocation path before release.

**Reproducible build of record (before deployment):** From the repository root,
with the pinned toolchain and installed lockfile dependencies, run:

```sh
node contracts/scripts/build-record.mjs
```

This forces a rebuild, compares compiler/settings and both keccak256 hashes with
[the committed record](release/ReceiptsRegistry.build.json), and exits non-zero
on any difference. The contracts CI job runs this same check. `--write` is only
for deliberately creating a new release record after review; never use it to
silence a verification failure. Expected hashes (unchanged before/after making
the Foundry defaults explicit):

| Code | keccak256 before = after |
|---|---|
| Creation bytecode | `0xb1e3dbfae90858ce41ca7d38fc90895d299804a52ad132cbde02e7d4e3210bcd` |
| Runtime bytecode | `0xf8808eb567bdd8ccb7e9496bda143440e32d5636dd687700e2807ee429fb1fd9` |

The probe profile's identical-setting rebuild also preserves `BwProbe`:
creation `0xe9f064f4bb72d7647dd1349a1ea40cbdb8a0b3968ab248c11f4cbeb3cc475177`,
runtime `0x78fb61d1890e8e9d8672783a61de08b42cce1815b773fc7e3fca83fa8f1a96ed`
before and after. The probe is simulation-only and must never be deployed.

The creation hash excludes ABI-encoded constructor arguments appended to the
transaction init code. The registry has no immutables or linked libraries:
`owner_` and `committer_` set storage, so they do not affect the runtime hash.
No enforced delay exists in this registry; the exact runtime pins that behavior.

**Deployment and exact two-step transfer:**

1. Prepare the operator's accepted chain-4663 deployment address manifest with
   `registry`, `initialOwner`, `owner` (the Safe), `pendingOwner` (zero after
   completion), `committer`, Safe signers and threshold 2. Cross-check registry
   with `ours.receiptsRegistry` in `packages/chain/addresses.4663.yaml` once
   deployed. Set its `owner` and `committer` fields to the accepted public role
   addresses; its `build_record` reference already names the committed record.
   Confirm Safe code, owners/threshold and absence of bypass modules.
   Manifest role addresses are public; secret material stays outside it.
2. Prefer setting `RECEIPTS_OWNER` to the verified Safe **at construction** and
   `RECEIPTS_COMMITTER` to the separate hot signer. The hardware deployer runs
   `DeployReceiptsRegistry.run()`; it assigns the supplied roles directly,
   rejects zero/equal addresses and confers no implicit ownership on the
   broadcast sender. Direct Safe construction needs no transfer or acceptance:
   `owner()` must already equal the Safe and `pendingOwner()` must be zero.
   With `RECEIPTS_OWNER` set to that verified Safe in the operator environment,
   run from `contracts/`:

   ```sh
   forge script script/DeployReceiptsRegistry.s.sol:DeployReceiptsRegistry \
     --rpc-url rhc --chain 4663 --ledger --broadcast --verify --verifier blockscout
   ```
3. For an existing deployment whose `RECEIPTS_OWNER` was the hardware deployer,
   that current owner signs `registry.transferOwnership(manifest.owner)`.
   If the initial owner differs from the deployer, **only that actual owner**
   can sign this call. After mining, read `owner()` = `manifest.initialOwner`
   and `pendingOwner()` = `manifest.owner`. A pending owner has no rotation
   power yet. The current owner may replace a mistaken pending destination,
   or cancel with `transferOwnership(address(0))`; this is not renunciation.
4. The Safe signers review an ordinary Safe transaction targeting the registry,
   value 0, call data `acceptOwnership()`. Collect two hardware signatures and
   execute it **from the Safe**, not from an individual signer. Acceptance
   requires `msg.sender == pendingOwner()`; it clears pending ownership and
   emits `OwnershipTransferred`. A transfer call alone is not completion.
5. At a recorded confirmed block, verify chain id 4663, registry address/code,
   `owner()` = `manifest.owner`, `pendingOwner()` = zero =
   `manifest.pendingOwner`, and `committer()` = `manifest.committer`. Re-read
   Safe signers and threshold. Retain both transaction hashes, role-change
   events and block with the release record. Check that the old owner cannot
   call `setCommitter` on a local fork; do not broadcast a failing probe.
   From the repository root, with the metered RPC environment configured:

   ```sh
   pnpm verify:chain
   ```

   Expected registry rows: `PASS` for `runtime hash`, `owner`, `pendingOwner`
   (zero), and `committer`; RPC `chainId` must be 4663. The summary is
   `verify:chain passed at block <block>` only when every check completes and
   every manifest entry is deployed. Default mode exits 1 for any `TODO` entry.
   During launch preparation, while later-stage entries still have `TODO`:

   ```sh
   pnpm verify:chain --prelaunch
   ```

   This prints `NOT DEPLOYED` rows and explicitly reports
   `(prelaunch; deployment verification incomplete); <count> manifest entries not deployed`.
   Only this mode can exit 0 with undeployed non-T entries. Missing T entries,
   any mismatch on a deployed entry, unavailable reads, exhausted RPC budget,
   SIGINT/SIGTERM, or the 120-second total verification deadline exit non-zero
   in both modes. Record the output and block; a prelaunch pass is not proof
   that an undeployed registry exists. Wallet entries are public destinations,
   not contract code checks. Future deployed EKO contracts fail until they have
   a build record and a role/delay/immutable verification profile. The registry
   verifier does not replace the separate Safe signer/threshold/module checks.

**Recovery:** A lost or compromised Safe signer is removed/replaced using the
remaining two signers; restore threshold 2, review any pending transactions and
confirm the resulting Safe configuration. One stolen signer cannot act alone.
If fewer than two uncompromised signers remain, use independently retained
hardware recovery material to regain quorum. There is no deployer backdoor; if
quorum cannot be recovered, freeze the committer service and publish the loss
of rotation authority rather than claiming recovery.

For a compromised committer, stop the receipts worker, then use two Safe
approvals immediately to call `setCommitter(address(0))` (disables new commits)
or `setCommitter(freshGasOnlySigner)`. Confirm `CommitterChanged` and
`committer()` before restarting. Replace the host-secret environment and
restart, or rotate the mounted `RECEIPTS_COMMITTER_KEY_FILE`, which the service
re-reads for each fresh attempt. Retain pending transaction evidence: rotation
does not rewrite already committed batches. Review/mark junk evidence and fund
only gas on the replacement signer (BACKEND §§13, 18).

**Never call `renounceOwnership()` on ReceiptsRegistry.** The inherited call
sets owner to zero and clears any pending owner. It permanently removes
`setCommitter` and ownership-transfer authority: a leaked committer could no
longer be rotated, or a zero committer could no longer be replaced. Existing
roots and public verification remain readable. BACKEND §14.9's later Burn
Engine renunciation is a different contract and does not apply here.

<!-- TODO(spec): §14.1 names robinhoodchain.blockscout.com but supplies no verifier API URL. Confirm it before using --verify; supply --verifier-url through the operator's environment/CLI. -->

## Fork check

```sh
forge test --match-path 'test/fork/*' -vv
```

It selects `rhc` at pinned block 77,469,811, checks chain id 4663, deploys the registry and
commits/verifies every fixture leaf. It skips explicitly when `RPC_HTTP_URL` is
unset. A supplied but failing RPC is an error, not a skip.

The pin matches the server and chain dependency suites. See
[candidate-linked results](../docs/security/FORK-TESTS.md) for the public RPC command and evidence.
