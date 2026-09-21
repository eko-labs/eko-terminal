// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiptsRegistry} from "../../src/ReceiptsRegistry.sol";
import {ReceiptFixture} from "../ReceiptFixture.sol";

contract ReceiptsRegistryForkTest is ReceiptFixture {
    // A recent Robinhood Chain block (the one verify:chain passed at on Oct 1, 2026), so the test runs on today's EVM.
    uint256 internal constant FORK_BLOCK = 77_469_811;

    function testForkCommitAndVerifyFixture() public {
        vm.skip(bytes(vm.envOr("RPC_HTTP_URL", string(""))).length == 0, "RPC_HTTP_URL unset: rhc fork skipped");
        vm.createSelectFork("rhc", FORK_BLOCK);
        assertEq(block.chainid, 4663);
        assertEq(block.number, FORK_BLOCK);
        loadFixture();
        address committer = makeAddr("fork-committer");
        ReceiptsRegistry registry = new ReceiptsRegistry(makeAddr("fork-owner"), committer);
        vm.prank(committer);
        uint64 id = registry.commit(fixtureRoot, uint32(fixtureLeaves.length));
        assertEq(id, 1);
        assertEq(registry.batch(id).root, fixtureRoot);
        for (uint256 i; i < fixtureLeaves.length; ++i) {
            assertTrue(registry.verify(id, fixtureLeaves[i], fixtureProofs[i]));
        }
    }
}
