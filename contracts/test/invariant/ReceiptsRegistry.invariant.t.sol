// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReceiptsRegistry} from "../../src/ReceiptsRegistry.sol";

contract ReceiptsHandler is Test {
    ReceiptsRegistry public registry;
    uint64 public successfulCommits;
    mapping(uint64 => bytes32) public originalRoots;
    bool public sequenceBroken;
    bool public verificationBroken;

    constructor() {
        registry = new ReceiptsRegistry(address(this), makeAddr("initial-committer"));
    }

    function commit(bytes32 root, uint32 leafCount) external {
        address current = registry.committer();
        if (current == address(0)) return;
        uint64 beforeId = registry.lastBatchId();
        vm.prank(current);
        try registry.commit(root, leafCount) returns (uint64 id) {
            ++successfulCommits;
            if (id != beforeId + 1 || registry.lastBatchId() != id || id != successfulCommits) {
                sequenceBroken = true;
            }
            // Preserve the first observed root even if a faulty implementation reuses an id.
            if (originalRoots[id] == bytes32(0)) originalRoots[id] = root;
        } catch {
            if (root != bytes32(0) && leafCount != 0) sequenceBroken = true;
            if (registry.lastBatchId() != beforeId) sequenceBroken = true;
        }
    }

    function rotate(address next) external {
        registry.setCommitter(next);
    }

    function verify(uint64 id, bytes32 leaf, bytes32[] memory proof) external {
        bool verified = registry.verify(id, leaf, proof);
        if ((id == 0 || id > successfulCommits) && verified) verificationBroken = true;
        // Empty proofs must accept the committed root itself (one-leaf membership).
        if (successfulCommits > 0) {
            uint64 committedId = uint64(bound(id, 1, successfulCommits));
            if (!registry.verify(committedId, originalRoots[committedId], new bytes32[](0))) {
                verificationBroken = true;
            }
        }
    }
}

contract ReceiptsRegistryInvariantTest is Test {
    ReceiptsHandler internal handler;
    ReceiptsRegistry internal registry;

    function setUp() public {
        handler = new ReceiptsHandler();
        registry = handler.registry();
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = ReceiptsHandler.commit.selector;
        selectors[1] = ReceiptsHandler.rotate.selector;
        selectors[2] = ReceiptsHandler.verify.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariantCommittedRootsNeverChange() public view {
        for (uint64 id = 1; id <= handler.successfulCommits(); ++id) {
            assertEq(registry.batch(id).root, handler.originalRoots(id));
        }
    }

    function invariantIdsRiseExactlyOnePerSuccessfulCommit() public view {
        assertFalse(handler.sequenceBroken());
        assertEq(registry.lastBatchId(), handler.successfulCommits());
    }

    function invariantEveryStoredBatchIsNonempty() public view {
        for (uint64 id = 1; id <= registry.lastBatchId(); ++id) {
            ReceiptsRegistry.Batch memory stored = registry.batch(id);
            assertTrue(stored.root != bytes32(0));
            assertGt(stored.leafCount, 0);
        }
    }

    function invariantVerificationMatchesCommittedState() public view {
        assertFalse(handler.verificationBroken());
    }
}
