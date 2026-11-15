// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISubscriptionManager as ISM} from "../src/interfaces/ISubscriptionManager.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract LifecycleTest is BaseTest {
    uint256 internal planId;
    uint256 internal subId;

    event SubscriptionCancelled(uint256 indexed subscriptionId, address indexed cancelledBy, uint64 cancelledAt);
    event AuthorizationUpdated(uint256 indexed subscriptionId, uint128 remainingCap, uint64 expiresAt);
    event AuthorizationRevoked(uint256 indexed subscriptionId);
    event Refunded(
        uint256 indexed subscriptionId, uint256 indexed merchantId, address indexed subscriber, uint128 amount
    );

    function setUp() public override {
        super.setUp();
        planId = _basicPlan();
        subId = _subscribe(bob, planId, 100e18);
    }

    // ------------------------------------------------------------------ cancel

    function test_cancel_bySubscriber() public {
        vm.expectEmit(address(manager));
        emit SubscriptionCancelled(subId, bob, uint64(block.timestamp));
        vm.prank(bob);
        manager.cancelSubscription(subId);

        ISM.Subscription memory s = _sub(subId);
        assertEq(uint8(s.status), uint8(ISM.SubscriptionStatus.Cancelled));
        assertEq(s.cancelledAt, block.timestamp);
        assertEq(manager.activeSubscriptionOf(planId, bob), 0);
        assertEq(manager.getPlan(planId).activeSubscribers, 0);

        vm.prank(bob);
        vm.expectRevert(ISM.SubscriptionNotActive.selector);
        manager.cancelSubscription(subId);
    }

    function test_cancel_byMerchant() public {
        vm.expectEmit(address(manager));
        emit SubscriptionCancelled(subId, alice, uint64(block.timestamp));
        vm.prank(alice);
        manager.cancelSubscription(subId);
    }

    function test_cancel_othersCannot() public {
        vm.prank(mallory);
        vm.expectRevert(ISM.NotSubscriber.selector);
        manager.cancelSubscription(subId);
        vm.prank(keeper);
        vm.expectRevert(ISM.NotSubscriber.selector);
        manager.cancelSubscription(subId);
        vm.prank(admin);
        vm.expectRevert(ISM.NotSubscriber.selector);
        manager.cancelSubscription(subId);
        vm.prank(bob);
        vm.expectRevert(ISM.SubscriptionNotFound.selector);
        manager.cancelSubscription(77);
    }

    // ------------------------------------------------------------------ revoke

    function test_revoke_activeSub() public {
        vm.expectEmit(address(manager));
        emit AuthorizationRevoked(subId);
        vm.expectEmit(address(manager));
        emit SubscriptionCancelled(subId, bob, uint64(block.timestamp));
        vm.prank(bob);
        manager.revokeAuthorization(subId);

        ISM.Subscription memory s = _sub(subId);
        assertEq(s.remainingCap, 0);
        assertEq(uint8(s.status), uint8(ISM.SubscriptionStatus.Cancelled));
        assertEq(manager.getPlan(planId).activeSubscribers, 0);

        vm.warp(s.nextBillingAt);
        vm.prank(alice);
        vm.expectRevert(ISM.SubscriptionNotActive.selector);
        manager.collectPayment(subId);
    }

    function test_revoke_alreadyCancelled_stillZeroesCap() public {
        vm.prank(alice);
        manager.cancelSubscription(subId);
        assertGt(_sub(subId).remainingCap, 0);

        vm.recordLogs();
        vm.prank(bob);
        manager.revokeAuthorization(subId);
        assertEq(vm.getRecordedLogs().length, 1); // AuthorizationRevoked only, no second cancel
        assertEq(_sub(subId).remainingCap, 0);
        assertEq(manager.getPlan(planId).activeSubscribers, 0); // not double-decremented
    }

    function test_revoke_onlySubscriber() public {
        vm.prank(alice);
        vm.expectRevert(ISM.NotSubscriber.selector);
        manager.revokeAuthorization(subId);
    }

    // ------------------------------------------------------------------ updateAuthorization

    function test_updateAuthorization() public {
        uint64 exp = uint64(block.timestamp + 365 days);
        vm.expectEmit(address(manager));
        emit AuthorizationUpdated(subId, 500e18, exp);
        vm.prank(bob);
        manager.updateAuthorization(subId, 500e18, exp);
        assertEq(_sub(subId).remainingCap, 500e18); // absolute, not additive
        assertEq(_sub(subId).expiresAt, exp);

        vm.startPrank(bob);
        vm.expectRevert(ISM.InvalidAuthorization.selector);
        manager.updateAuthorization(subId, 1, uint64(block.timestamp));
        manager.updateAuthorization(subId, 0, 0); // pause billing by zero cap
        vm.stopPrank();
        assertEq(_sub(subId).remainingCap, 0);

        vm.prank(alice);
        vm.expectRevert(ISM.NotSubscriber.selector);
        manager.updateAuthorization(subId, 1e30, 0);

        vm.prank(bob);
        manager.cancelSubscription(subId);
        vm.prank(bob);
        vm.expectRevert(ISM.SubscriptionNotActive.selector);
        manager.updateAuthorization(subId, 1, 0);
    }

    // ------------------------------------------------------------------ refunds

    function test_refund() public {
        musd.mint(alice, 50e18);
        vm.prank(alice);
        musd.approve(address(manager), type(uint256).max);
        uint256 bobBefore = musd.balanceOf(bob);

        vm.expectEmit(address(manager));
        emit Refunded(subId, merchantId, bob, 4e18);
        vm.prank(alice);
        manager.refund(subId, 4e18);

        assertEq(musd.balanceOf(bob) - bobBefore, 4e18);
        assertEq(musd.balanceOf(alice), 46e18);
        assertEq(_sub(subId).totalRefunded, 4e18);
        assertEq(musd.balanceOf(address(manager)), 0);

        // cannot exceed totalPaid - totalRefunded
        vm.prank(alice);
        vm.expectRevert(ISM.RefundTooLarge.selector);
        manager.refund(subId, PRICE - 4e18 + 1);
        vm.prank(alice);
        vm.expectRevert(ISM.ZeroAmount.selector);
        manager.refund(subId, 0);

        // works on cancelled subs and while paused
        vm.prank(bob);
        manager.cancelSubscription(subId);
        vm.prank(admin);
        manager.pause();
        vm.prank(alice);
        manager.refund(subId, PRICE - 4e18);
        assertEq(_sub(subId).totalRefunded, PRICE);
    }

    function test_refund_onlyMerchantOwner_andFromOwnWallet() public {
        vm.prank(mallory);
        vm.expectRevert(ISM.NotMerchantOwner.selector);
        manager.refund(subId, 1e18);
        vm.prank(admin);
        vm.expectRevert(ISM.NotMerchantOwner.selector);
        manager.refund(subId, 1e18);
        vm.prank(alice);
        vm.expectRevert(ISM.SubscriptionNotFound.selector);
        manager.refund(99, 1e18);

        // alice has no allowance -> the token transfer reverts; payout funds never touched
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(manager), 0, 1e18)
        );
        manager.refund(subId, 1e18);
        assertEq(_sub(subId).totalRefunded, 0);
    }

    function test_refund_trialSubHasNothingToRefund() public {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.trialPeriod = 1 days;
        uint256 pid = _createPlan(p);
        uint256 id = _subscribe(carol, pid, 100e18);
        vm.prank(alice);
        vm.expectRevert(ISM.RefundTooLarge.selector);
        manager.refund(id, 1);
    }

    // ------------------------------------------------------------------ pagination

    function test_pagination() public {
        // bob subscribes to 4 more plans -> 5 total
        for (uint256 i = 0; i < 4; ++i) {
            _subscribe(bob, _basicPlan(), 100e18);
        }
        (uint256[] memory ids, uint256 total) = manager.getSubscriberSubscriptions(bob, 0, 2);
        assertEq(total, 5);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);

        (ids, total) = manager.getSubscriberSubscriptions(bob, 3, 10); // clamps
        assertEq(ids.length, 2);
        assertEq(ids[0], 4);
        assertEq(ids[1], 5);

        (ids, total) = manager.getSubscriberSubscriptions(bob, 5, 10); // offset == total
        assertEq(ids.length, 0);
        assertEq(total, 5);
        (ids,) = manager.getSubscriberSubscriptions(bob, type(uint256).max, type(uint256).max);
        assertEq(ids.length, 0);
        (ids,) = manager.getSubscriberSubscriptions(bob, 1, type(uint256).max); // no overflow
        assertEq(ids.length, 4);
        (ids,) = manager.getSubscriberSubscriptions(bob, 0, 0);
        assertEq(ids.length, 0);

        (ids, total) = manager.getMerchantPlans(merchantId, 1, 2);
        assertEq(total, 5);
        assertEq(ids[0], 2);
        assertEq(ids[1], 3);

        (ids, total) = manager.getMerchantSubscriptions(merchantId, 4, 1);
        assertEq(total, 5);
        assertEq(ids[0], 5);

        (ids, total) = manager.getMerchantSubscriptions(999, 0, 10);
        assertEq(total, 0);
        assertEq(ids.length, 0);
    }

    function test_views_unknown() public {
        vm.expectRevert(ISM.PlanNotFound.selector);
        manager.getPlan(0);
        vm.expectRevert(ISM.SubscriptionNotFound.selector);
        manager.getSubscription(0);
        assertEq(manager.amountDue(0), 0);
        assertFalse(manager.isDue(0));
    }
}
