// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {IMerchantRegistry} from "../src/interfaces/IMerchantRegistry.sol";

contract MerchantRegistryTest is Test {
    MerchantRegistry internal reg;
    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal payout = makeAddr("payout");

    event MerchantRegistered(uint256 indexed merchantId, address indexed owner, address payout, string metadataURI);
    event MerchantOwnershipTransferred(
        uint256 indexed merchantId, address indexed previousOwner, address indexed newOwner
    );

    function setUp() public {
        reg = new MerchantRegistry(admin);
    }

    function test_constructor_rejectsZeroAdmin() public {
        vm.expectRevert(IMerchantRegistry.ZeroAddress.selector);
        new MerchantRegistry(address(0));
    }

    function test_register_defaults() public {
        vm.expectEmit(address(reg));
        emit MerchantRegistered(1, alice, payout, "uri");
        vm.prank(alice);
        uint256 id = reg.registerMerchant(payout, "uri");

        assertEq(id, 1);
        IMerchantRegistry.Merchant memory m = reg.getMerchant(id);
        assertEq(m.owner, alice);
        assertEq(m.payout, payout);
        assertEq(uint8(m.status), uint8(IMerchantRegistry.MerchantStatus.Active));
        assertTrue(m.keeperEnabled);
        assertEq(m.createdAt, block.timestamp);
        assertEq(m.metadataURI, "uri");
        assertEq(reg.merchantIdOf(alice), 1);
        assertEq(reg.merchantCount(), 1);
        assertTrue(reg.isActive(1));

        vm.prank(bob);
        assertEq(reg.registerMerchant(bob, ""), 2);
    }

    function test_register_duplicateOwnerReverts() public {
        vm.startPrank(alice);
        reg.registerMerchant(payout, "a");
        vm.expectRevert(IMerchantRegistry.AlreadyRegistered.selector);
        reg.registerMerchant(payout, "b");
        vm.stopPrank();
    }

    function test_register_zeroPayoutReverts() public {
        vm.prank(alice);
        vm.expectRevert(IMerchantRegistry.ZeroAddress.selector);
        reg.registerMerchant(address(0), "a");
    }

    function test_ownerSetters_onlyOwner() public {
        vm.prank(alice);
        uint256 id = reg.registerMerchant(payout, "a");

        vm.startPrank(bob);
        vm.expectRevert(IMerchantRegistry.NotMerchantOwner.selector);
        reg.setPayout(id, bob);
        vm.expectRevert(IMerchantRegistry.NotMerchantOwner.selector);
        reg.setMetadataURI(id, "x");
        vm.expectRevert(IMerchantRegistry.NotMerchantOwner.selector);
        reg.setKeeperEnabled(id, false);
        vm.expectRevert(IMerchantRegistry.NotMerchantOwner.selector);
        reg.pauseMerchant(id);
        vm.expectRevert(IMerchantRegistry.NotMerchantOwner.selector);
        reg.transferMerchantOwnership(id, bob);
        vm.stopPrank();

        vm.expectRevert(IMerchantRegistry.MerchantNotFound.selector);
        reg.setPayout(99, bob);

        vm.startPrank(alice);
        vm.expectRevert(IMerchantRegistry.ZeroAddress.selector);
        reg.setPayout(id, address(0));
        reg.setPayout(id, bob);
        reg.setMetadataURI(id, "new");
        reg.setKeeperEnabled(id, false);
        vm.stopPrank();

        IMerchantRegistry.Merchant memory m = reg.getMerchant(id);
        assertEq(m.payout, bob);
        assertEq(m.metadataURI, "new");
        assertFalse(m.keeperEnabled);
    }

    function test_statusTransitions() public {
        vm.prank(alice);
        uint256 id = reg.registerMerchant(payout, "a");

        vm.startPrank(alice);
        vm.expectRevert(IMerchantRegistry.InvalidStatusTransition.selector);
        reg.resumeMerchant(id); // Active -> Active not allowed
        reg.pauseMerchant(id);
        assertFalse(reg.isActive(id));
        vm.expectRevert(IMerchantRegistry.InvalidStatusTransition.selector);
        reg.pauseMerchant(id);
        reg.resumeMerchant(id);
        assertTrue(reg.isActive(id));
        vm.stopPrank();

        // only admin can suspend / unsuspend
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, bytes32(0))
        );
        reg.suspendMerchant(id);

        vm.prank(admin);
        reg.suspendMerchant(id);
        assertEq(uint8(reg.getMerchant(id).status), uint8(IMerchantRegistry.MerchantStatus.Suspended));

        // owner cannot lift a suspension
        vm.prank(alice);
        vm.expectRevert(IMerchantRegistry.InvalidStatusTransition.selector);
        reg.resumeMerchant(id);

        vm.startPrank(admin);
        vm.expectRevert(IMerchantRegistry.InvalidStatusTransition.selector);
        reg.suspendMerchant(id);
        reg.unsuspendMerchant(id);
        vm.expectRevert(IMerchantRegistry.InvalidStatusTransition.selector);
        reg.unsuspendMerchant(id);
        vm.expectRevert(IMerchantRegistry.MerchantNotFound.selector);
        reg.suspendMerchant(42);
        vm.stopPrank();

        // Paused -> Suspended also allowed
        vm.prank(alice);
        reg.pauseMerchant(id);
        vm.prank(admin);
        reg.suspendMerchant(id);
    }

    function test_transferOwnership_updatesBothWays() public {
        vm.prank(alice);
        uint256 id = reg.registerMerchant(payout, "a");

        vm.expectEmit(address(reg));
        emit MerchantOwnershipTransferred(id, alice, bob);
        vm.prank(alice);
        reg.transferMerchantOwnership(id, bob);

        assertEq(reg.getMerchant(id).owner, bob);
        assertEq(reg.merchantIdOf(bob), id);
        assertEq(reg.merchantIdOf(alice), 0);

        // alice lost control and may register a new merchant
        vm.prank(alice);
        vm.expectRevert(IMerchantRegistry.NotMerchantOwner.selector);
        reg.setPayout(id, alice);
        vm.prank(alice);
        assertEq(reg.registerMerchant(payout, "b"), 2);

        // cannot transfer to a wallet that already owns a merchant, or to zero
        vm.startPrank(bob);
        vm.expectRevert(IMerchantRegistry.AlreadyRegistered.selector);
        reg.transferMerchantOwnership(id, alice);
        vm.expectRevert(IMerchantRegistry.ZeroAddress.selector);
        reg.transferMerchantOwnership(id, address(0));
        vm.expectRevert(IMerchantRegistry.AlreadyRegistered.selector);
        reg.transferMerchantOwnership(id, bob);
        vm.stopPrank();
    }

    function test_views_unknownMerchant() public {
        vm.expectRevert(IMerchantRegistry.MerchantNotFound.selector);
        reg.getMerchant(0);
        assertFalse(reg.isActive(0));
        assertEq(reg.merchantIdOf(alice), 0);
    }
}
