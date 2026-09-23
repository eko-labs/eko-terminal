// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiptsRegistry} from "../../src/ReceiptsRegistry.sol";
import {ReceiptFixture} from "../ReceiptFixture.sol";

contract GuardReceiptCompatibilityTest is ReceiptFixture {
    function testMixedV1V2RawPayloadsUseExistingRegistry() public {
        loadFixture("guard-v2");
        ReceiptsRegistry registry = new ReceiptsRegistry(address(this), address(this));
        uint64 batchId = registry.commit(fixtureRoot, uint32(fixtureLeaves.length));
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/../packages/shared/test/fixtures/receipts/guard-v2.json")
        );
        for (uint256 i; i < fixtureLeaves.length; ++i) {
            string memory item = string.concat(".items[", vm.toString(i), "]");
            string memory canonical = abi.decode(vm.parseJson(json, string.concat(item, ".canonicalPayload")), (string));
            bytes32 payloadHash = abi.decode(vm.parseJson(json, string.concat(item, ".hash")), (bytes32));
            assertEq(keccak256(bytes(canonical)), payloadHash);
            assertTrue(registry.verify(batchId, fixtureLeaves[i], fixtureProofs[i]));
            bytes32 changed = keccak256(bytes.concat(keccak256(abi.encode(uint8(0), bytes32(0), payloadHash))));
            assertFalse(registry.verify(batchId, changed, fixtureProofs[i]));
        }
        // The corrected assessment appends a new leaf. The original remains
        // verifiable; neither supersession nor an orphan status rewrites it.
        bytes32 oldId = abi.decode(vm.parseJson(json, ".items[3].payload.revisionId"), (bytes32));
        bytes32 supersedes = abi.decode(vm.parseJson(json, ".items[7].payload.decision.supersedes"), (bytes32));
        assertEq(oldId, supersedes);
        assertTrue(registry.verify(batchId, fixtureLeaves[3], fixtureProofs[3]));
        assertTrue(registry.verify(batchId, fixtureLeaves[7], fixtureProofs[7]));
    }
}
