// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISubscriptionManager as ISM} from "../src/interfaces/ISubscriptionManager.sol";
import {IMerchantRegistry as IMR} from "../src/interfaces/IMerchantRegistry.sol";

/// Regression tests for the findings of the 2-pass solidity-auditor scan (2026-11-12).
contract AuditFixesTest is BaseTest {
    // ------------------------------------------------ unfunded-trial-slot / expired-auth-holds-seat

    function _cappedTrialPlan(uint32 maxSubs) internal returns (uint256) {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.trialPeriod = 7 days;
        p.maxSubscribers = maxSubs;
        return _createPlan(p);
    }

    function test_unfundedTrial_seatReleasedAfterGrace() public {
        uint256 planId = _cappedTrialPlan(1);
        vm.prank(mallory); // no tokens, no allowance
        uint256 id = manager.subscribe(planId, 1, PRICE, 0);
        assertEq(manager.getPlan(planId).activeSubscribers, 1);

        // carol is locked out while the seat is held
        vm.prank(carol);
        vm.expectRevert(ISM.PlanFull.selector);
        manager.subscribe(planId, 1, PRICE, 0);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        // trial ends: payment fails, but the subscription is inside its grace interval
        vm.warp(_sub(id).nextBillingAt);
        vm.prank(keeper);
        manager.collectDuePayments(ids);
        assertEq(uint8(_sub(id).status), uint8(ISM.SubscriptionStatus.Active));

        // one full interval past due and still unpaid: the keeper batch cancels it and frees the seat
        vm.warp(_sub(id).nextBillingAt + MONTH);
        vm.prank(keeper);
        manager.collectDuePayments(ids);
        assertEq(uint8(_sub(id).status), uint8(ISM.SubscriptionStatus.Cancelled));
        assertEq(manager.getPlan(planId).activeSubscribers, 0);

        _subscribe(carol, planId, PRICE * 12);
        assertEq(manager.getPlan(planId).activeSubscribers, 1);
    }

    function test_expiredAuthorization_seatReleasedAfterGrace() public {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.maxSubscribers = 1;
        uint256 planId = _createPlan(p);
        uint32 v = manager.getPlan(planId).termsVersion;
        vm.prank(bob);
        uint256 id = manager.subscribe(planId, v, PRICE * 12, uint64(block.timestamp + 1));

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.warp(_sub(id).nextBillingAt + MONTH - 1);
        vm.prank(keeper);
        manager.collectDuePayments(ids); // AuthorizationExpired, still within grace
        assertEq(uint8(_sub(id).status), uint8(ISM.SubscriptionStatus.Active));

        vm.warp(_sub(id).nextBillingAt + MONTH);
        vm.prank(keeper);
        manager.collectDuePayments(ids);
        assertEq(uint8(_sub(id).status), uint8(ISM.SubscriptionStatus.Cancelled));
        assertEq(manager.getPlan(planId).activeSubscribers, 0);
    }

    function test_paidSubscription_retryWithinGraceStillWorks() public {
        uint256 planId = _basicPlan();
        uint256 id = _subscribe(bob, planId, PRICE * 12);
        vm.prank(bob);
        musd.approve(address(manager), 0);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.warp(_sub(id).nextBillingAt + 1 days);
        vm.prank(keeper);
        manager.collectDuePayments(ids); // fails, not lapsed
        vm.prank(bob);
        musd.approve(address(manager), type(uint256).max);
        vm.prank(keeper);
        assertEq(manager.collectDuePayments(ids), 1);
        assertEq(_sub(id).paymentsCount, 2);
    }

    // ------------------------------------------------ resubscribe-restarts-trial-and-intro

    function test_resubscribe_noSecondTrialOrIntro() public {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.trialPeriod = 7 days;
        p.introAmount = 1e18;
        p.introPeriods = 1;
        uint256 planId = _createPlan(p);

        uint256 first = _subscribe(bob, planId, PRICE * 12);
        assertEq(_sub(first).paymentsCount, 0); // trial, nothing charged
        assertTrue(manager.hasSubscribed(planId, bob));
        vm.prank(bob);
        manager.cancelSubscription(first);

        uint256 balBefore = musd.balanceOf(bob);
        uint256 second = _subscribe(bob, planId, PRICE * 12);
        ISM.Subscription memory s = _sub(second);
        assertEq(s.paymentsCount, 1, "returning subscriber is charged now");
        assertEq(s.introPeriods, 0);
        assertEq(balBefore - musd.balanceOf(bob), PRICE, "full price, not the intro price");
        assertEq(s.nextBillingAt, block.timestamp + MONTH);

        // a new wallet still gets the trial
        assertFalse(manager.hasSubscribed(planId, carol));
        uint256 c = _subscribe(carol, planId, PRICE * 12);
        assertEq(_sub(c).paymentsCount, 0);
    }

    // ------------------------------------------------ suspended-owner-transfer

    function test_suspendedMerchant_cannotBeTransferred() public {
        vm.prank(admin);
        registry.suspendMerchant(merchantId);
        vm.prank(alice);
        vm.expectRevert(IMR.InvalidStatusTransition.selector);
        registry.transferMerchantOwnership(merchantId, mallory);
        // alice is still bound to the suspended merchant, so she cannot register a fresh one
        vm.prank(alice);
        vm.expectRevert(IMR.AlreadyRegistered.selector);
        registry.registerMerchant(payout, "again");
    }

    // ------------------------------------------------ payout-to-contract-sink

    function test_payoutSetToManager_blocksSubscribeAndCollect() public {
        uint256 planId = _basicPlan();
        uint256 id = _subscribe(bob, planId, PRICE * 12);

        vm.prank(alice);
        registry.setPayout(merchantId, address(manager));

        vm.prank(carol);
        vm.expectRevert(ISM.MerchantNotActive.selector);
        manager.subscribe(planId, 1, PRICE * 12, 0);

        vm.warp(_sub(id).nextBillingAt);
        (ISM.CollectionCheck c,) = manager.previewCollection(id, alice);
        assertEq(uint8(c), uint8(ISM.CollectionCheck.MerchantInactive));
        assertEq(musd.balanceOf(address(manager)), 0);
    }

    function test_payoutSetToToken_blocksCollect() public {
        uint256 planId = _basicPlan();
        uint256 id = _subscribe(bob, planId, PRICE * 12);
        vm.prank(alice);
        registry.setPayout(merchantId, address(musd));
        vm.warp(_sub(id).nextBillingAt);
        vm.prank(alice);
        vm.expectRevert(ISM.MerchantNotActive.selector);
        manager.collectPayment(id);
    }
}
