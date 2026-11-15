// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISubscriptionManager as ISM} from "../src/interfaces/ISubscriptionManager.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract SubscribeTest is BaseTest {
    event Subscribed(
        uint256 indexed subscriptionId,
        uint256 indexed planId,
        uint256 indexed merchantId,
        address subscriber,
        uint128 amount,
        uint32 interval,
        uint32 termsVersion,
        uint128 spendCap,
        uint64 expiresAt,
        uint64 nextBillingAt
    );
    event PaymentCollected(
        uint256 indexed subscriptionId,
        uint256 indexed merchantId,
        address indexed subscriber,
        address payout,
        address token,
        uint128 amount,
        uint32 periodIndex,
        uint64 billedFor,
        uint64 nextBillingAt,
        address collector
    );

    // ------------------------------------------------------------------ no trial

    function test_subscribe_noTrial_chargesFirstPeriod() public {
        uint256 planId = _basicPlan();
        uint64 t = uint64(block.timestamp);

        vm.expectEmit(address(manager));
        emit Subscribed(1, planId, merchantId, bob, PRICE, MONTH, 1, 100e18, 0, t + MONTH);
        vm.expectEmit(address(manager));
        emit PaymentCollected(1, merchantId, bob, payout, address(musd), PRICE, 0, t, t + MONTH, bob);

        vm.prank(bob);
        uint256 id = manager.subscribe(planId, 1, 100e18, 0);

        assertEq(id, 1);
        assertEq(musd.balanceOf(payout), PRICE);
        assertEq(musd.balanceOf(bob), 1_000e18 - PRICE);
        assertEq(musd.balanceOf(address(manager)), 0);

        ISM.Subscription memory s = _sub(id);
        assertEq(s.planId, planId);
        assertEq(s.merchantId, merchantId);
        assertEq(s.subscriber, bob);
        assertEq(s.token, address(musd));
        assertEq(s.amount, PRICE);
        assertEq(s.interval, MONTH);
        assertEq(s.termsVersion, 1);
        assertEq(s.remainingCap, 100e18 - PRICE);
        assertEq(s.expiresAt, 0);
        assertEq(s.nextBillingAt, t + MONTH);
        assertEq(s.createdAt, t);
        assertEq(s.lastPaymentAt, t);
        assertEq(s.paymentsCount, 1);
        assertEq(s.totalPaid, PRICE);
        assertEq(uint8(s.status), uint8(ISM.SubscriptionStatus.Active));

        assertEq(manager.activeSubscriptionOf(planId, bob), id);
        assertEq(manager.getPlan(planId).activeSubscribers, 1);
        assertEq(manager.subscriptionCount(), 1);
        (uint256[] memory ids, uint256 total) = manager.getSubscriberSubscriptions(bob, 0, 10);
        assertEq(total, 1);
        assertEq(ids[0], id);
        (ids, total) = manager.getMerchantSubscriptions(merchantId, 0, 10);
        assertEq(total, 1);
        assertEq(ids[0], id);
    }

    // ------------------------------------------------------------------ trial

    function test_subscribe_trial_noCharge() public {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.trialPeriod = 7 days;
        uint256 planId = _createPlan(p);

        uint256 bal = musd.balanceOf(bob);
        uint256 id = _subscribe(bob, planId, 100e18);
        ISM.Subscription memory s = _sub(id);
        assertEq(musd.balanceOf(bob), bal);
        assertEq(s.paymentsCount, 0);
        assertEq(s.totalPaid, 0);
        assertEq(s.lastPaymentAt, 0);
        assertEq(s.remainingCap, 100e18);
        assertEq(s.nextBillingAt, block.timestamp + 7 days);

        // not due during the trial
        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(alice);
        vm.expectRevert(ISM.NotDue.selector);
        manager.collectPayment(id);

        // due at trial end: period 0 billed for trial end
        vm.warp(block.timestamp + 1);
        uint64 trialEnd = uint64(block.timestamp);
        vm.expectEmit(address(manager));
        emit PaymentCollected(id, merchantId, bob, payout, address(musd), PRICE, 0, trialEnd, trialEnd + MONTH, alice);
        _collectAs(alice, id);
    }

    function test_subscribe_trial_noBalanceNeeded() public {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.trialPeriod = 7 days;
        uint256 planId = _createPlan(p);
        // mallory has no tokens and no allowance: trial still starts
        vm.prank(mallory);
        manager.subscribe(planId, 1, PRICE, 0);
    }

    function test_subscribe_trial_capMustCoverFirstCharge() public {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.trialPeriod = 7 days;
        uint256 planId = _createPlan(p);
        vm.prank(bob);
        vm.expectRevert(ISM.InvalidAuthorization.selector);
        manager.subscribe(planId, 1, PRICE - 1, 0);
    }

    // ------------------------------------------------------------------ intro pricing

    function test_introPricingSequence() public {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.introAmount = 1e18;
        p.introPeriods = 2;
        uint256 planId = _createPlan(p);

        // cap only needs to cover the intro price
        vm.prank(bob);
        vm.expectRevert(ISM.InvalidAuthorization.selector);
        manager.subscribe(planId, 1, 1e18 - 1, 0);

        uint256 id = _subscribe(bob, planId, 100e18);
        assertEq(musd.balanceOf(payout), 1e18); // period 0 = intro
        assertEq(manager.amountDue(id), 1e18); // period 1 = intro

        vm.warp(_sub(id).nextBillingAt);
        assertEq(_collectAs(alice, id), 1e18);
        assertEq(manager.amountDue(id), PRICE); // period 2 = full

        vm.warp(_sub(id).nextBillingAt);
        assertEq(_collectAs(alice, id), PRICE);
        vm.warp(_sub(id).nextBillingAt);
        assertEq(_collectAs(alice, id), PRICE);

        ISM.Subscription memory s = _sub(id);
        assertEq(s.paymentsCount, 4);
        assertEq(s.totalPaid, 2e18 + 2 * PRICE);
        assertEq(musd.balanceOf(payout), 2e18 + 2 * PRICE);
        assertEq(s.remainingCap, 100e18 - s.totalPaid);
    }

    // ------------------------------------------------------------------ guards

    function test_subscribe_guards() public {
        uint256 planId = _basicPlan();

        vm.prank(bob);
        vm.expectRevert(ISM.PlanNotFound.selector);
        manager.subscribe(99, 1, 100e18, 0);

        // TermsChanged
        vm.prank(bob);
        vm.expectRevert(ISM.TermsChanged.selector);
        manager.subscribe(planId, 2, 100e18, 0);

        // InvalidAuthorization: expiry in the past / now, cap below first charge
        vm.prank(bob);
        vm.expectRevert(ISM.InvalidAuthorization.selector);
        manager.subscribe(planId, 1, 100e18, uint64(block.timestamp));
        vm.prank(bob);
        vm.expectRevert(ISM.InvalidAuthorization.selector);
        manager.subscribe(planId, 1, PRICE - 1, 0);

        // AlreadySubscribed
        _subscribe(bob, planId, 100e18);
        vm.prank(bob);
        vm.expectRevert(ISM.AlreadySubscribed.selector);
        manager.subscribe(planId, 1, 100e18, 0);
    }

    function test_subscribe_termsChangedGuard_frontRunPriceHike() public {
        uint256 planId = _basicPlan();
        uint32 seen = manager.getPlan(planId).termsVersion;

        // merchant raises the price before bob's tx lands
        vm.prank(alice);
        manager.updatePlan(planId, _params(PRICE * 10, MONTH));

        uint256 bal = musd.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(ISM.TermsChanged.selector);
        manager.subscribe(planId, seen, 1_000e18, 0);
        assertEq(musd.balanceOf(bob), bal);
    }

    function test_subscribe_canResubscribeAfterCancel() public {
        uint256 planId = _basicPlan();
        uint256 a = _subscribe(bob, planId, 100e18);
        vm.prank(bob);
        manager.cancelSubscription(a);
        uint256 b = _subscribe(bob, planId, 100e18);
        assertTrue(a != b);
        assertEq(manager.activeSubscriptionOf(planId, bob), b);
    }

    function test_subscribe_planFull() public {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.maxSubscribers = 1;
        uint256 planId = _createPlan(p);
        uint256 a = _subscribe(bob, planId, 100e18);
        vm.prank(carol);
        vm.expectRevert(ISM.PlanFull.selector);
        manager.subscribe(planId, 1, 100e18, 0);
        // a cancel frees the slot
        vm.prank(bob);
        manager.cancelSubscription(a);
        _subscribe(carol, planId, 100e18);
    }

    function test_subscribe_merchantInactive() public {
        uint256 planId = _basicPlan();
        vm.prank(alice);
        registry.pauseMerchant(merchantId);
        vm.prank(bob);
        vm.expectRevert(ISM.MerchantNotActive.selector);
        manager.subscribe(planId, 1, 100e18, 0);

        vm.prank(alice);
        registry.resumeMerchant(merchantId);
        vm.prank(admin);
        registry.suspendMerchant(merchantId);
        vm.prank(bob);
        vm.expectRevert(ISM.MerchantNotActive.selector);
        manager.subscribe(planId, 1, 100e18, 0);
    }

    function test_subscribe_whilePaused() public {
        uint256 planId = _basicPlan();
        vm.prank(admin);
        manager.pause();
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        manager.subscribe(planId, 1, 100e18, 0);
    }

    function test_subscribe_tokenDelisted() public {
        uint256 planId = _basicPlan();
        vm.prank(admin);
        manager.setTokenAllowed(address(musd), false);
        vm.prank(bob);
        vm.expectRevert(ISM.TokenNotAllowed.selector);
        manager.subscribe(planId, 1, 100e18, 0);
    }

    function test_subscribe_insufficientBalance_noStateChange() public {
        uint256 planId = _basicPlan();
        vm.prank(mallory);
        musd.approve(address(manager), type(uint256).max);
        vm.prank(mallory);
        vm.expectRevert(ISM.InsufficientBalance.selector);
        manager.subscribe(planId, 1, 100e18, 0);
        assertEq(manager.subscriptionCount(), 0);
        assertEq(manager.getPlan(planId).activeSubscribers, 0);
    }

    function test_subscribe_insufficientAllowance_noStateChange() public {
        uint256 planId = _basicPlan();
        musd.mint(mallory, 100e18);
        vm.prank(mallory);
        musd.approve(address(manager), PRICE - 1);
        vm.prank(mallory);
        vm.expectRevert(ISM.InsufficientAllowance.selector);
        manager.subscribe(planId, 1, 100e18, 0);
        assertEq(manager.subscriptionCount(), 0);
        assertEq(musd.balanceOf(mallory), 100e18);
    }

    // ------------------------------------------------------------------ permit

    function _permitSig(uint256 pk, address owner, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                address(manager),
                value,
                musd.nonces(owner),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", musd.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function test_subscribeWithPermit() public {
        uint256 planId = _basicPlan();
        (address dave, uint256 pk) = makeAddrAndKey("dave");
        musd.mint(dave, 100e18);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, dave, 50e18, deadline);

        vm.prank(dave);
        uint256 id = manager.subscribeWithPermit(planId, 1, 50e18, 0, 50e18, deadline, v, r, s);

        assertEq(musd.balanceOf(payout), PRICE);
        assertEq(musd.allowance(dave, address(manager)), 50e18 - PRICE);
        assertEq(_sub(id).remainingCap, 50e18 - PRICE);
    }

    function test_subscribeWithPermit_frontRunPermitStillWorks() public {
        uint256 planId = _basicPlan();
        (address dave, uint256 pk) = makeAddrAndKey("dave");
        musd.mint(dave, 100e18);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, dave, 50e18, deadline);

        // attacker submits the permit first (nonce consumed)
        vm.prank(mallory);
        musd.permit(dave, address(manager), 50e18, deadline, v, r, s);

        vm.prank(dave);
        uint256 id = manager.subscribeWithPermit(planId, 1, 50e18, 0, 50e18, deadline, v, r, s);
        assertEq(_sub(id).paymentsCount, 1);
        assertEq(musd.balanceOf(payout), PRICE);
    }

    function test_subscribeWithPermit_badPermitFallsBackToAllowance() public {
        uint256 planId = _basicPlan();
        // bob already has an allowance: garbage signature is tolerated
        vm.prank(bob);
        uint256 id = manager.subscribeWithPermit(planId, 1, 50e18, 0, 50e18, block.timestamp, 0, 0, 0);
        assertEq(_sub(id).paymentsCount, 1);

        // no allowance and a bad permit -> InsufficientAllowance
        musd.mint(mallory, 100e18);
        vm.prank(mallory);
        vm.expectRevert(ISM.InsufficientAllowance.selector);
        manager.subscribeWithPermit(planId, 1, 50e18, 0, 50e18, block.timestamp, 0, 0, 0);
    }

    function test_subscribeWithPermit_unknownPlan() public {
        vm.prank(bob);
        vm.expectRevert(ISM.PlanNotFound.selector);
        manager.subscribeWithPermit(7, 1, 50e18, 0, 50e18, block.timestamp, 0, 0, 0);
    }
}
