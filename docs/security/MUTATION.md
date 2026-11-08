# Core contract mutation measurement

This refreshes the exact-source mutation evidence required by the 2026-10-03
internal audit’s Path to 9/10 evidence-maintenance item. The scope is **every
authored Solidity file in `contracts/src/`**:
currently only `ReceiptsRegistry.sol`. Vendor contracts, deployment scripts,
tests, off-chain code and the simulation probe are outside the mutation scope.
The Forge suite exercises inherited ownership behavior but vendor implementations
are not mutated. This is evidence for the scoped operator set, not a claim that
all possible faulty implementations are detected.

Run from the repository root with installed dependencies and cached solc:

```sh
pnpm --filter @eko/contracts mutation
# Equivalent standalone command:
node contracts/scripts/mutate.mjs
# Enumerate exact source edits without compiling or executing them:
node contracts/scripts/mutate.mjs --list
```

The current measurement ran `node contracts/scripts/mutate.mjs` offline on
2026-10-03 at base commit `c5c048a456af52c7a0787ee4450cd9e4514be9e7` plus
uncommitted evidence-maintenance changes. The JSON hashes pin the exact current
source, tests, runner, configuration and dependencies independently of that base.

Environment: Node **26.0.0**, Forge **1.7.1-Homebrew**, Foundry commit
`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`, solc
**0.8.26+commit.8a97fa7a**, Cancun, optimizer **10,000** runs, `via_ir = false`,
IPFS bytecode metadata and CBOR enabled. No installs or network calls are needed.
The runner imports only Node built-ins. The root workspace checks used the
existing Node 26.0.0 / pnpm 11.5.1 environment.

The runner copies `foundry.toml` unchanged, all authored source/tests/scripts,
vendored forge-std, installed OpenZeppelin source and shared receipt fixtures to
a temporary project. It restores the original source after each single edit;
compiler artifacts are local to that project. Persisted invariant counterexamples
are removed between mutants. The temporary project is removed in `finally`.
It clears Foundry/Dapp setting overrides and receipt signer variables and unsets
`RPC_HTTP_URL`; the optional hosted fork is explicitly skipped. The original
source, release build record and compiler settings are never edited.

Each candidate first runs `forge build --offline`. A compiler rejection has no
kill credit. Every compiling mutant then runs:

```sh
forge test --offline --json --fuzz-seed 0x1 --threads 2
```

This runs the full suite with **1,000 fuzz runs**, **256 invariant runs** and
**64 invariant depth**, as configured in `foundry.toml`. It does not filter or
weaken tests. The lexicographically first failing test is retained as
`killingTest` (a `setUp()` failure also counts as a test kill). Compiler errors,
process timeouts, invalid JSON and inconsistent exit statuses are distinguished;
infrastructure errors abort without writing a new score. The command fails for
an unhealthy baseline, an unresolved survivor or a score below 80%. It takes
several minutes, so it is separate from the default `pnpm test` gate.

[The JSON result](../../contracts/release/mutation.json) records each edit's id,
source file, line and offset, original/replacement snippet, outcome and killing
test when known. It also records baseline results, compiler error codes, exact
source/test/script/config/runner hashes and dependency/fixture hashes. It omits
timestamps, durations, temporary paths, raw logs and generated counterexamples.
With identical inputs and tool versions, candidate order and the fixed seed
produce deterministic output. IDs include rejected visibility candidates, so
admitted mutant IDs have deliberate gaps.

## Operators and denominator

Candidates are ordered by relative filename and source position, then edit end,
operator and replacement. Comments, strings, imports, pragmas and type
declarations are excluded. Identical edits at the same span are deduplicated;
different source edits with identical semantics remain separate syntactic
mutants. This is a small token runner for the current contract's grammar, not a
complete Solidity AST framework. Review generation before applying it to a new
syntax shape.

| Operator | Exact behavior | Candidates |
| --- | --- | ---: |
| Relational replacement | Each `<`, `<=`, `>`, `>=`, `==`, `!=` becomes every other member of that set | 20 |
| Arithmetic replacement | Each binary `+`, `-`, `*`, `/`, `%` becomes every other member; no such sites here | 0 |
| Logical replacement | `&&` ↔ `\|\|` | 2 |
| Logical negation removal | Remove `!`; no such sites here | 0 |
| Boolean literal flip | `true` ↔ `false`; no such literals here | 0 |
| Guard removal | Remove a whole `if (…) revert CustomError();`, or replace its revert with an empty block; standalone require/revert removal is also supported | 4 |
| Guard/if condition negation | Wrap the condition in `!(…)`; the two guards are also the only `if`s, so their identical guard/if edits are counted once as `if-negation`; require first-argument negation is supported | 2 |
| Assignment removal | Remove a statement, including local declarations; additionally remove only a scalar declaration's initializer to retain its default value | 6 |
| Delete removal | Remove a `delete` statement; no such sites here | 0 |
| Emit removal | Remove each entire `emit` statement | 3 |
| Modifier removal | Remove bare `only*` function modifiers; the only site is `onlyOwner` | 1 |
| Unary changes | Unary `+`/`-`/`~` replacements; no such sites here | 0 |
| Increment changes | Prefix `++` becomes `--`, no increment, or postfix `++` | 3 |
| Return replacement | Explicit expressions become 0, 1, uint256 max, false or true; named uint64 return additionally gets explicit 0, 1 or uint64 max | 13 |
| Constant replacement | Executable numeric literals become 0, 1 or max, omitting identity edits; integer casts make address/bytes constants well-typed | 8 |
| Visibility tightening | Function external/public → internal/private, internal → private; admitted only if the full project still compiles | 8 rejected, 0 admitted |
| **Total** | **70 generated candidates; 62 admitted mutants** | **70** |

The eight visibility candidates cannot compile because the suite calls all four
external functions. They are recorded separately in `rejectedVisibility` rather
than admitted as kills. Of the **62 admitted mutants**, **9 fail to compile**,
**50 are killed** and **3 survive**. Those three survivors are equivalent for the
precise reasons below.

- Compiling denominator before equivalence review: **53**.
- Conservative score including every compiling survivor: **50 / 53 = 94.34%**.
- Reviewed equivalent survivors excluded: **3**.
- **Non-equivalent denominator: 50; killed: 50; mutation score: 100%.**

Exact current source SHA-256: `c8cc2e8dc778a2a70e14ffa7f0c5859b8876988c65bd3d3dac64bb0b949e79e4`.

Equivalence is not inferred from a passing suite. The runner's three arguments
are pinned to the exact source SHA-256 and exact edits; any other survivor remains
unresolved and makes the command fail. Even without any equivalence exclusions,
the measurement exceeds 80%.

## Every final survivor

All locations below are in `contracts/src/ReceiptsRegistry.sol`. These are the
only final survivors; none represents an accepted observable behavior change.

| ID | Line | Original → replacement | Disposition and equivalence argument |
| --- | ---: | --- | --- |
| M0019 | 83 | root `==` bytes32(0) → `<=` | Equivalent: bytes32 has unsigned 256-bit ordering. Its only value ≤ zero is zero. The same inputs trigger EmptyBatch, with identical short-circuit evaluation, state and events. |
| M0027 | 83 | leafCount `==` 0 → `<=` | Equivalent: leafCount is uint32. For every representable input, ≤ zero iff equal to zero. Rejection, evaluation order and observable state/events are unchanged. |
| M0066 | 115 | root `!=` bytes32(0) → `>` | Equivalent: unsigned bytes32 is nonzero iff greater than zero, for both stored and default roots. Proof evaluation, returns and reverts are unchanged. |

A separate isolated solc build of each of these three edits also confirmed
byte-identical creation and runtime executable code after removing the trailing
Solidity CBOR metadata (the source hash in metadata necessarily changes). This
confirms identical instruction and gas behavior, in addition to the value-domain
arguments. SHA-256 of the current baseline executable bytes, excluding CBOR:

| Code | SHA-256 |
| --- | --- |
| Creation | `317f35cca749feab0206faa26a4e84488fd7a3eabfb91620f6ffcb8f980243f0` |
| Runtime | `674dae17ff9057c97929c5df6dd6370af6bb7e1f2e460be145d1462579fdee90` |

These hashes are supplemental equivalence evidence; they do not replace or
modify the committed release build record, which hashes complete bytecode.

## Real survivors closed by tests

The initial exploration found two observable verification faults. The final
runner also makes numeric replacement 1 well-typed, so it measures that nearby
fault instead of discarding it as a compiler rejection.

| Final ID | Fault | Test that directly detects it |
| --- | --- | --- |
| M0067 | `root >= bytes32(0)` admits a default zero root to proof verification, allowing zero leaf/empty proof for an unknown batch | `testZeroLeafAndEmptyProofNeverVerifyUnknownBatch` |
| M0068 | Compare root against uint256 max instead of zero: accepts unknown zero root/zero leaf, and rejects an actual max root | `testZeroLeafAndEmptyProofNeverVerifyUnknownBatch`; `testSingleLeafBoundaryRootsCountsAndTimestamps` |
| M0069 | Compare root against 1 instead of zero: accepts unknown zero root/zero leaf, and rejects an actual root of 1 | `testZeroLeafAndEmptyProofNeverVerifyUnknownBatch`; `testSingleLeafBoundaryRootsCountsAndTimestamps` |

The boundary test checks exact event emitter/topics/data, returned ids, sequence,
all stored fields, timestamps 0/uint64 max, counts 1/uint32 max, empty-proof
membership and rejection of a different leaf. It rechecks the first batch after
the second append. Additional tests check every batch field after unauthorized
and empty calls (including NotCommitter precedence), unchanged sequence and
unused storage, and exact event arguments for same-committer, zero-committer and
recovery rotations. Existing tests and assertions are preserved.

Spec basis: BACKEND §§13, 14.2, 18 and the registry test row in §21. This refresh
changes evidence and exact-source equivalence pins only; there are no product
behavior changes or new `TODO(spec)`
decisions. The historical audit score/report has not been rewritten or rescored.

## Completion checks

Checks below ran against the current candidate. Historical gate results are not
carried forward as evidence.

| Command | Exit | Result |
| --- | ---: | --- |
| `node contracts/scripts/mutate.mjs` | 0 | Offline baseline: 38 passed, 0 failed, 1 optional RPC fork skipped; 50/53 conservative kills; 3 reviewed equivalents; 50/50 non-equivalent kills |
| Independent offline baseline/survivor builds | 0 | All three survivors have identical creation/runtime executable bytes after CBOR removal |
| Reference, inventory and mutation-input validation | 0 | 260 exact file:line references, 69 census entries, 424 current source paths and all hashes/70 edits verified |
| `pnpm typecheck` | 0 | All applicable workspace typechecks passed |
| `VITEST_MAX_WORKERS=2 pnpm test` | 0 | Full root gate, recursive suites, workspace builds and built-role checks passed |
| `pnpm brand:check` | 0 | 229 files checked after workspace builds |

Candidate edits, counters and every recorded source/test/script/config/runner,
dependency and fixture hash are verified against the current files. NatSpec
changed source offsets and compiler metadata; survivor ids and value-domain
arguments remain unchanged. No source behavior, compiler setting, dependency,
or normal-suite timeout changed. Work remains uncommitted.
