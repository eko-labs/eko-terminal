// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

abstract contract ReceiptFixture is Test {
    bytes32 internal fixtureRoot;
    bytes32[] internal fixtureLeaves;
    bytes32[][] internal fixtureProofs;

    function loadFixture() internal {
        loadFixture("v1");
    }

    function loadFixture(string memory name) internal {
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/../packages/shared/test/fixtures/receipts/", name, ".json")
        );
        fixtureRoot = abi.decode(vm.parseJson(json, ".root"), (bytes32));
        fixtureLeaves = abi.decode(vm.parseJson(json, ".items[*].leaf"), (bytes32[]));
        for (uint256 i; i < fixtureLeaves.length; ++i) {
            string memory item = string.concat(".items[", vm.toString(i), "]");
            string memory id = abi.decode(vm.parseJson(json, string.concat(item, ".id")), (string));
            string memory kind = abi.decode(vm.parseJson(json, string.concat(item, ".kind")), (string));
            uint8 kindId = uint8(abi.decode(vm.parseJson(json, string.concat(".kindIds.", kind)), (uint256)));
            bytes32 itemId = abi.decode(vm.parseJson(json, string.concat(item, ".itemId")), (bytes32));
            bytes32 hash = abi.decode(vm.parseJson(json, string.concat(item, ".hash")), (bytes32));
            assertEq(itemId, keccak256(bytes(id)));
            assertEq(fixtureLeaves[i], keccak256(bytes.concat(keccak256(abi.encode(kindId, itemId, hash)))));
            fixtureProofs.push(
                abi.decode(vm.parseJson(json, string.concat(".proofs[", vm.toString(i), "]")), (bytes32[]))
            );
        }
    }
}
