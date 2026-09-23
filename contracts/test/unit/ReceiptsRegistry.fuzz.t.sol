// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReceiptsRegistry} from "../../src/ReceiptsRegistry.sol";

contract ReceiptsRegistryFuzzTest is Test {
    ReceiptsRegistry internal registry;
    address internal committer;

    function setUp() public {
        committer = makeAddr("hot-committer");
        registry = new ReceiptsRegistry(address(this), committer);
    }

    function testFuzzCommit(bytes32 root, uint32 leafCount) public {
        vm.prank(committer);
        if (root == bytes32(0) || leafCount == 0) {
            vm.expectRevert(ReceiptsRegistry.EmptyBatch.selector);
            registry.commit(root, leafCount);
            assertEq(registry.lastBatchId(), 0);
            assertEq(registry.batch(1).root, bytes32(0));
        } else {
            assertEq(registry.commit(root, leafCount), 1);
            assertEq(registry.lastBatchId(), 1);
            assertEq(registry.batch(1).root, root);
            assertEq(registry.batch(1).leafCount, leafCount);
            assertEq(registry.batch(1).committer, committer);
        }
    }

    function testFuzzVerifyNeverAcceptsUncommittedId(uint64 id, bytes32 leaf, bytes32[] memory proof) public {
        // Include a committed batch so this covers both zero and unknown ids alongside real state.
        vm.prank(committer);
        registry.commit(keccak256("committed-root"), 1);
        vm.assume(id != 1);
        assertFalse(registry.verify(id, leaf, proof));
    }

    function testFuzzNonCommitterAlwaysReverts(address caller, bytes32 root, uint32 leafCount) public {
        vm.assume(caller != committer);
        vm.prank(caller);
        vm.expectRevert(ReceiptsRegistry.NotCommitter.selector);
        registry.commit(root, leafCount);
        assertEq(registry.lastBatchId(), 0);
    }
}
