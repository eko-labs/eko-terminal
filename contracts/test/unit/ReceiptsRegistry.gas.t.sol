// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiptsRegistry} from "../../src/ReceiptsRegistry.sol";
import {ReceiptFixture} from "../ReceiptFixture.sol";

contract ReceiptsRegistryGasTest is ReceiptFixture {
    ReceiptsRegistry internal registry;
    uint64 internal fixtureBatch;

    function setUp() public {
        loadFixture();
        registry = new ReceiptsRegistry(address(this), address(this));
        fixtureBatch = registry.commit(fixtureRoot, uint32(fixtureLeaves.length));
    }

    function testGasCommit() public {
        registry.commit(fixtureRoot, uint32(fixtureLeaves.length));
    }

    function testGasVerifyTwoElementProof() public view {
        registry.verify(fixtureBatch, fixtureLeaves[0], fixtureProofs[0]);
    }

    function testGasVerifyOneElementProof() public view {
        registry.verify(fixtureBatch, fixtureLeaves[1], fixtureProofs[1]);
    }
}
