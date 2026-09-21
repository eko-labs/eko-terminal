// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ReceiptsRegistry} from "../src/ReceiptsRegistry.sol";

contract DeployReceiptsRegistry is Script {
    error ZeroRoleAddress();
    error RolesMustDiffer();

    function run() external returns (ReceiptsRegistry registry) {
        address owner = vm.envAddress("RECEIPTS_OWNER");
        address committer = vm.envAddress("RECEIPTS_COMMITTER");
        if (owner == address(0) || committer == address(0)) revert ZeroRoleAddress();
        if (owner == committer) revert RolesMustDiffer();

        vm.startBroadcast();
        registry = new ReceiptsRegistry(owner, committer);
        vm.stopBroadcast();
        console2.log("ReceiptsRegistry deployed at", address(registry));
        console2.log("Deployment block (simulation; confirm broadcast receipt)", block.number);
    }
}
