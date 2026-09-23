// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployReceiptsRegistry} from "../../script/DeployReceiptsRegistry.s.sol";
import {ReceiptsRegistry} from "../../src/ReceiptsRegistry.sol";

contract DeployReceiptsRegistryTest is Test {
    DeployReceiptsRegistry internal deployScript;
    address internal owner;
    address internal committer;

    function setUp() public {
        deployScript = new DeployReceiptsRegistry();
        owner = makeAddr("deployment-owner");
        committer = makeAddr("deployment-committer");
    }

    function testDeployUsesEnvironmentRolesAndRejectsInvalidRoles() public {
        // Environment changes are process-wide, so all script cases run in one
        // test to avoid races between Foundry's parallel test runners.
        vm.setEnv("RECEIPTS_OWNER", vm.toString(owner));
        vm.setEnv("RECEIPTS_COMMITTER", vm.toString(committer));
        ReceiptsRegistry registry = deployScript.run();
        assertEq(registry.owner(), owner);
        assertEq(registry.committer(), committer);
        assertEq(registry.lastBatchId(), 0);

        vm.setEnv("RECEIPTS_COMMITTER", vm.toString(owner));
        vm.expectRevert(DeployReceiptsRegistry.RolesMustDiffer.selector);
        deployScript.run();

        vm.setEnv("RECEIPTS_OWNER", vm.toString(address(0)));
        vm.expectRevert(DeployReceiptsRegistry.ZeroRoleAddress.selector);
        deployScript.run();

        vm.setEnv("RECEIPTS_OWNER", vm.toString(owner));
        vm.setEnv("RECEIPTS_COMMITTER", vm.toString(address(0)));
        vm.expectRevert(DeployReceiptsRegistry.ZeroRoleAddress.selector);
        deployScript.run();
        vm.setEnv("RECEIPTS_OWNER", "");
        vm.setEnv("RECEIPTS_COMMITTER", "");
    }
}
