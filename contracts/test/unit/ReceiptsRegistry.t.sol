// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReceiptsRegistry} from "../../src/ReceiptsRegistry.sol";
import {ReceiptFixture} from "../ReceiptFixture.sol";

contract ReceiptsRegistryTest is ReceiptFixture {
    ReceiptsRegistry internal registry;
    address internal owner;
    address internal committer;
    address internal nextCommitter;

    event CommitterChanged(address indexed previous, address indexed next);
    event BatchCommitted(uint64 indexed batchId, bytes32 indexed root, uint32 leafCount, address indexed committer);

    function setUp() public {
        owner = makeAddr("cold-owner");
        committer = makeAddr("hot-committer");
        nextCommitter = makeAddr("next-committer");
        registry = new ReceiptsRegistry(owner, committer);
        loadFixture();
    }

    function commitFixture() internal returns (uint64) {
        vm.prank(committer);
        return registry.commit(fixtureRoot, uint32(fixtureLeaves.length));
    }

    function testConstructor() public {
        vm.expectEmit(true, true, false, true);
        emit CommitterChanged(address(0), committer);
        ReceiptsRegistry fresh = new ReceiptsRegistry(owner, committer);
        assertEq(fresh.owner(), owner);
        assertEq(fresh.committer(), committer);
        assertEq(fresh.lastBatchId(), 0);
    }

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ReceiptsRegistry(address(0), committer);
    }

    function testCommitHappyPath() public {
        vm.warp(123456);
        vm.expectEmit(true, true, true, true, address(registry));
        emit BatchCommitted(1, fixtureRoot, uint32(fixtureLeaves.length), committer);
        uint64 id = commitFixture();
        assertEq(id, 1);
        assertEq(registry.lastBatchId(), id);
        ReceiptsRegistry.Batch memory stored = registry.batch(id);
        assertEq(stored.root, fixtureRoot);
        assertEq(stored.leafCount, fixtureLeaves.length);
        assertEq(stored.committedAt, block.timestamp);
        assertEq(stored.committer, committer);
    }

    function testNonCommitterReverts() public {
        vm.prank(owner);
        vm.expectRevert(ReceiptsRegistry.NotCommitter.selector);
        registry.commit(fixtureRoot, 3);
        assertEq(registry.lastBatchId(), 0);
    }

    function testZeroRootReverts() public {
        vm.prank(committer);
        vm.expectRevert(ReceiptsRegistry.EmptyBatch.selector);
        registry.commit(bytes32(0), 3);
        assertEq(registry.lastBatchId(), 0);
    }

    function testZeroLeafCountReverts() public {
        vm.prank(committer);
        vm.expectRevert(ReceiptsRegistry.EmptyBatch.selector);
        registry.commit(fixtureRoot, 0);
        assertEq(registry.lastBatchId(), 0);
    }

    function testIdsStartAtOneAndAreSequential() public {
        for (uint64 i = 1; i <= 5; ++i) {
            assertEq(commitFixture(), i);
            assertEq(registry.lastBatchId(), i);
        }
        // Failed calls don't consume an id.
        vm.prank(committer);
        vm.expectRevert(ReceiptsRegistry.EmptyBatch.selector);
        registry.commit(fixtureRoot, 0);
        assertEq(commitFixture(), 6);
    }

    function testJunkCannotBlockOverwriteOrReorderHonestBatches() public {
        uint64 first = commitFixture();
        bytes32 junk = keccak256("junk-batch");
        vm.prank(committer); // The leaked key can append, but cannot choose an id.
        assertEq(registry.commit(junk, type(uint32).max), 2);
        assertEq(commitFixture(), 3);
        vm.prank(owner);
        registry.setCommitter(nextCommitter);
        vm.prank(committer);
        vm.expectRevert(ReceiptsRegistry.NotCommitter.selector);
        registry.commit(junk, 1);
        vm.prank(nextCommitter);
        assertEq(registry.commit(fixtureRoot, 3), 4);
        assertEq(registry.batch(first).root, fixtureRoot);
        assertEq(registry.batch(2).root, junk);
        assertEq(registry.batch(3).root, fixtureRoot);
        assertEq(registry.batch(4).root, fixtureRoot);
        assertEq(registry.batch(3).committer, committer);
        assertEq(registry.batch(4).committer, nextCommitter);
        assertEq(registry.lastBatchId(), 4);
    }

    function testRotationEmitsAndRevokesOldCommitter() public {
        commitFixture();
        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(registry));
        emit CommitterChanged(committer, nextCommitter);
        registry.setCommitter(nextCommitter);
        assertEq(registry.committer(), nextCommitter);
        vm.prank(committer);
        vm.expectRevert(ReceiptsRegistry.NotCommitter.selector);
        registry.commit(fixtureRoot, 3);
        vm.prank(nextCommitter);
        assertEq(registry.commit(fixtureRoot, 3), 2);
        assertEq(registry.batch(1).root, fixtureRoot);
    }

    function testOnlyOwnerRotates() public {
        vm.prank(committer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, committer));
        registry.setCommitter(nextCommitter);
        assertEq(registry.committer(), committer);
    }

    function testOwnershipTransferRequiresAcceptance() public {
        address pending = makeAddr("pending-owner");
        vm.prank(owner);
        registry.transferOwnership(pending);
        assertEq(registry.owner(), owner);
        assertEq(registry.pendingOwner(), pending);
        vm.prank(pending);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, pending));
        registry.setCommitter(nextCommitter);
        vm.prank(committer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, committer));
        registry.acceptOwnership();
        vm.prank(pending);
        registry.acceptOwnership();
        assertEq(registry.owner(), pending);
        assertEq(registry.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        registry.setCommitter(nextCommitter);
        vm.prank(pending);
        registry.setCommitter(nextCommitter);
    }

    function testOnlyOwnerTransfersOwnership() public {
        vm.prank(committer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, committer));
        registry.transferOwnership(nextCommitter);
    }

    function testEveryFixtureLeafVerifies() public {
        uint64 id = commitFixture();
        for (uint256 i; i < fixtureLeaves.length; ++i) {
            assertTrue(registry.verify(id, fixtureLeaves[i], fixtureProofs[i]));
        }
    }

    function testWrongLeafDoesNotVerify() public {
        assertFalse(registry.verify(commitFixture(), keccak256("wrong-leaf"), fixtureProofs[0]));
    }

    function testWrongProofDoesNotVerify() public {
        assertFalse(registry.verify(commitFixture(), fixtureLeaves[0], fixtureProofs[1]));
    }

    function testTamperedProofDoesNotVerify() public {
        bytes32[] memory proof = fixtureProofs[0];
        proof[0] = bytes32(uint256(proof[0]) ^ 1);
        assertFalse(registry.verify(commitFixture(), fixtureLeaves[0], proof));
    }

    function testUnknownAndZeroBatchDoNotVerify() public {
        commitFixture();
        assertFalse(registry.verify(0, fixtureLeaves[0], fixtureProofs[0]));
        assertFalse(registry.verify(2, fixtureLeaves[0], fixtureProofs[0]));
    }

    function testUnknownBatchIsZeroed() public view {
        ReceiptsRegistry.Batch memory stored = registry.batch(1);
        assertEq(stored.root, bytes32(0));
        assertEq(stored.leafCount, 0);
        assertEq(stored.committedAt, 0);
        assertEq(stored.committer, address(0));
    }

    function testZeroLeafAndEmptyProofNeverVerifyUnknownBatch() public {
        bytes32[] memory proof = new bytes32[](0);
        assertFalse(registry.verify(0, bytes32(0), proof));
        assertFalse(registry.verify(1, bytes32(0), proof));
        commitFixture();
        assertFalse(registry.verify(0, bytes32(0), proof));
        assertFalse(registry.verify(2, bytes32(0), proof));
        assertFalse(registry.verify(type(uint64).max, bytes32(0), proof));
    }

    function testSingleLeafBoundaryRootsCountsAndTimestamps() public {
        bytes32[2] memory roots = [bytes32(uint256(1)), bytes32(type(uint256).max)];
        uint32[2] memory counts = [uint32(1), type(uint32).max];
        uint64[2] memory times = [uint64(0), type(uint64).max];
        bytes32[] memory proof = new bytes32[](0);
        for (uint64 i; i < 2; ++i) {
            vm.warp(times[i]);
            vm.expectEmit(true, true, true, true, address(registry));
            emit BatchCommitted(i + 1, roots[i], counts[i], committer);
            vm.prank(committer);
            assertEq(registry.commit(roots[i], counts[i]), i + 1);
            assertEq(registry.lastBatchId(), i + 1);
            assertStoredBatch(i + 1, roots[i], counts[i], times[i], committer);
            // Proof verification uses the root; leafCount is the committer's recorded count.
            assertTrue(registry.verify(i + 1, roots[i], proof));
            assertFalse(registry.verify(i + 1, roots[1 - i], proof));
        }
        assertStoredBatch(1, roots[0], counts[0], times[0], committer);
        assertTrue(registry.verify(1, roots[0], proof));
    }

    function testRejectedCallsPreserveAllBatchFieldsAndSequence() public {
        vm.warp(987654);
        commitFixture();
        address[2] memory callers = [address(1), address(type(uint160).max)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(ReceiptsRegistry.NotCommitter.selector);
            registry.commit(bytes32(0), 0);
            assertEq(registry.lastBatchId(), 1);
            assertEq(registry.committer(), committer);
            assertStoredBatch(1, fixtureRoot, uint32(fixtureLeaves.length), 987654, committer);
            assertStoredBatch(2, bytes32(0), 0, 0, address(0));
        }
        vm.prank(committer);
        vm.expectRevert(ReceiptsRegistry.EmptyBatch.selector);
        registry.commit(bytes32(0), 0);
        assertEq(registry.lastBatchId(), 1);
        assertStoredBatch(1, fixtureRoot, uint32(fixtureLeaves.length), 987654, committer);
        assertStoredBatch(2, bytes32(0), 0, 0, address(0));
        assertEq(commitFixture(), 2);
    }

    function testSameAndZeroCommitterRotationsEmitExactArguments() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit CommitterChanged(committer, committer);
        vm.prank(owner);
        registry.setCommitter(committer);
        assertEq(registry.committer(), committer);
        assertEq(registry.lastBatchId(), 0);
        vm.expectEmit(true, true, false, true, address(registry));
        emit CommitterChanged(committer, address(0));
        vm.prank(owner);
        registry.setCommitter(address(0));
        assertEq(registry.committer(), address(0));
        vm.expectEmit(true, true, false, true, address(registry));
        emit CommitterChanged(address(0), nextCommitter);
        vm.prank(owner);
        registry.setCommitter(nextCommitter);
        assertEq(registry.committer(), nextCommitter);
        assertEq(registry.lastBatchId(), 0);
    }

    function assertStoredBatch(uint64 id, bytes32 root, uint32 count, uint64 timestamp, address sender) internal view {
        ReceiptsRegistry.Batch memory stored = registry.batch(id);
        assertEq(stored.root, root);
        assertEq(stored.leafCount, count);
        assertEq(stored.committedAt, timestamp);
        assertEq(stored.committer, sender);
    }

    // These behaviours are preserved from §14.2 and flagged for the launch review.
    function testZeroCommitterCanBeSetAndRecovered() public {
        vm.prank(owner);
        registry.setCommitter(address(0));
        assertEq(registry.committer(), address(0));
        vm.prank(committer);
        vm.expectRevert(ReceiptsRegistry.NotCommitter.selector);
        registry.commit(fixtureRoot, 3);
        vm.prank(owner);
        registry.setCommitter(committer);
        assertEq(commitFixture(), 1);
    }

    function testConstructorAllowsZeroCommitter() public {
        ReceiptsRegistry fresh = new ReceiptsRegistry(owner, address(0));
        assertEq(fresh.committer(), address(0));
    }

    function testRenouncingOwnershipLeavesCommitterButRemovesRotation() public {
        vm.prank(owner);
        registry.renounceOwnership();
        assertEq(registry.owner(), address(0));
        assertEq(commitFixture(), 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        registry.setCommitter(nextCommitter);
    }

    function testNonOwnerCannotRenounceOwnership() public {
        address pending = makeAddr("pending-owner");
        vm.prank(owner);
        registry.transferOwnership(pending);
        address[2] memory callers = [committer, pending];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            registry.renounceOwnership();
            assertEq(registry.owner(), owner);
            assertEq(registry.pendingOwner(), pending);
            assertEq(registry.committer(), committer);
        }
        assertEq(commitFixture(), 1);
    }
}
