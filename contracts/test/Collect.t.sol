// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISubscriptionManager as ISM} from "../src/interfaces/ISubscriptionManager.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

contract CollectTest is BaseTest {
    uint256 internal planId;
    uint256 internal subId;

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

    function setUp() public override {
        super.setUp();
        planId = _basicPlan();
        subId = _subscribe(bob, planId, 100e18);
    }

    function _snapshot() internal view returns (bytes32) {
        return keccak256(abi.encode(_sub(subId)));
    }

    function _check(address caller) internal view returns (ISM.CollectionCheck c) {
        (c,) = manager.previewCollection(subId, caller);
    }

    // ------------------------------------------------------------------ happy path

    function test_collect_movesExactAmountToPayout() public {
        ISM.Subscription memory before = _sub(subId);
        vm.warp(before.nextBillingAt);

        (ISM.CollectionCheck c, uint128 amt) = manager.previewCollection(subId, alice);
        assertEq(uint8(c), uint8(ISM.CollectionCheck.Ok));
        assertEq(amt, PRICE);
        assertTrue(manager.isDue(subId));

        uint256 payoutBefore = musd.balanceOf(payout);
        uint256 bobBefore = musd.balanceOf(bob);

        vm.expectEmit(address(manager));
        emit PaymentCollected(
            subId,
            merchantId,
            bob,
            payout,
            address(musd),
            PRICE,
            1,
            before.nextBillingAt,
            before.nextBillingAt + MONTH,
            alice
        );
        assertEq(_collectAs(alice, subId), PRICE);

        assertEq(musd.balanceOf(payout) - payoutBefore, PRICE);
        assertEq(bobBefore - musd.balanceOf(bob), PRICE);
        assertEq(musd.balanceOf(address(manager)), 0);
        assertEq(musd.balanceOf(alice), 0); // owner wallet receives nothing, payout does

        ISM.Subscription memory s = _sub(subId);
        assertEq(s.paymentsCount, 2);
        assertEq(s.totalPaid, 2 * PRICE);
        assertEq(s.remainingCap, before.remainingCap - PRICE);
        assertEq(s.lastPaymentAt, block.timestamp);
        assertEq(s.nextBillingAt, before.nextBillingAt + MONTH);
    }

    function test_collect_byEnabledKeeper() public {
        vm.warp(_sub(subId).nextBillingAt);
        vm.expectEmit(address(manager));
        emit PaymentCollected(
            subId,
            merchantId,
            bob,
            payout,
            address(musd),
            PRICE,
            1,
            uint64(block.timestamp),
            uint64(block.timestamp) + MONTH,
            keeper
        );
        _collectAs(keeper, subId);
    }

    // ------------------------------------------------------------------ timing

    function test_collect_beforeDueReverts() public {
        vm.warp(_sub(subId).nextBillingAt - 1);
        assertFalse(manager.isDue(subId));
        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.NotDue));
        vm.prank(alice);
        vm.expectRevert(ISM.NotDue.selector);
        manager.collectPayment(subId);
    }

    function test_collect_duplicateForSamePeriodReverts() public {
        vm.warp(_sub(subId).nextBillingAt);
        _collectAs(alice, subId);
        vm.prank(keeper);
        vm.expectRevert(ISM.NotDue.selector);
        manager.collectPayment(subId);
    }

    function test_collect_noBackBillingAfterLongLapse() public {
        uint64 due = _sub(subId).nextBillingAt;
        vm.warp(due + 5 * MONTH + 3 days); // five periods missed
        uint256 payoutBefore = musd.balanceOf(payout);
        _collectAs(alice, subId);
        assertEq(musd.balanceOf(payout) - payoutBefore, PRICE); // exactly one period

        ISM.Subscription memory s = _sub(subId);
        assertEq(s.nextBillingAt, block.timestamp + MONTH); // restarts from now
        vm.prank(alice);
        vm.expectRevert(ISM.NotDue.selector);
        manager.collectPayment(subId);
    }

    /// Audit fix (late-collection-spacing): a late charge restarts the period from the charge, so the next charge is
    /// a full interval later. Before the fix, a charge at due + MONTH - 1 left the next one due one second later.
    function test_collect_lateCollectionLeavesFullInterval() public {
        uint64 due = _sub(subId).nextBillingAt;
        vm.warp(due + MONTH - 1);
        _collectAs(alice, subId);
        assertEq(_sub(subId).nextBillingAt, block.timestamp + MONTH);
        vm.warp(due + MONTH); // one second later: not due again
        assertFalse(manager.isDue(subId));
        vm.prank(alice);
        vm.expectRevert(ISM.NotDue.selector);
        manager.collectPayment(subId);
    }

    function test_collect_onTimeKeepsCadence() public {
        uint64 due = _sub(subId).nextBillingAt;
        vm.warp(due);
        _collectAs(alice, subId);
        assertEq(_sub(subId).nextBillingAt, due + MONTH);
    }

    // ------------------------------------------------------------------ lifecycle guards

    function test_collect_afterCancelReverts() public {
        vm.prank(bob);
        manager.cancelSubscription(subId);
        vm.warp(block.timestamp + 2 * MONTH);
        assertFalse(manager.isDue(subId));
        vm.prank(alice);
        vm.expectRevert(ISM.SubscriptionNotActive.selector);
        manager.collectPayment(subId);
    }

    function test_collect_unknownSubReverts() public {
        vm.prank(alice);
        vm.expectRevert(ISM.SubscriptionNotFound.selector);
        manager.collectPayment(999);
        (ISM.CollectionCheck c, uint128 amt) = manager.previewCollection(999, alice);
        assertEq(uint8(c), uint8(ISM.CollectionCheck.NotFound));
        assertEq(amt, 0);
    }

    // ------------------------------------------------------------------ authorization of collectors

    function test_collect_otherMerchantCannotCollect() public {
        address eve = makeAddr("eve");
        vm.prank(eve);
        registry.registerMerchant(eve, "eve");
        vm.warp(_sub(subId).nextBillingAt);
        vm.prank(eve);
        vm.expectRevert(ISM.NotAuthorizedCollector.selector);
        manager.collectPayment(subId);
    }

    function test_collect_randomAccountCannotCollect() public {
        vm.warp(_sub(subId).nextBillingAt);
        vm.prank(mallory);
        vm.expectRevert(ISM.NotAuthorizedCollector.selector);
        manager.collectPayment(subId);
        // not even the subscriber or the payout wallet
        vm.prank(bob);
        vm.expectRevert(ISM.NotAuthorizedCollector.selector);
        manager.collectPayment(subId);
        vm.prank(payout);
        vm.expectRevert(ISM.NotAuthorizedCollector.selector);
        manager.collectPayment(subId);
    }

    function test_collect_keeperWithoutRoleCannotCollect() public {
        bytes32 role = manager.KEEPER_ROLE();
        vm.prank(admin);
        manager.revokeRole(role, keeper);
        vm.warp(_sub(subId).nextBillingAt);
        vm.prank(keeper);
        vm.expectRevert(ISM.NotAuthorizedCollector.selector);
        manager.collectPayment(subId);
    }

    function test_collect_keeperBlockedWhenMerchantDisablesKeeper() public {
        vm.prank(alice);
        registry.setKeeperEnabled(merchantId, false);
        vm.warp(_sub(subId).nextBillingAt);
        vm.prank(keeper);
        vm.expectRevert(ISM.NotAuthorizedCollector.selector);
        manager.collectPayment(subId);
        // owner still can
        _collectAs(alice, subId);
    }

    function test_collect_followsOwnershipTransfer() public {
        vm.prank(alice);
        registry.transferMerchantOwnership(merchantId, carol);
        vm.warp(_sub(subId).nextBillingAt);
        vm.prank(alice);
        vm.expectRevert(ISM.NotAuthorizedCollector.selector);
        manager.collectPayment(subId);
        _collectAs(carol, subId);
    }

    // ------------------------------------------------------------------ authorization of the charge

    function test_collect_cannotExceedCap() public {
        uint256 planId2 = _createPlan(_params(PRICE, MIN_INTERVAL));
        uint256 id = _subscribe(carol, planId2, PRICE * 2 + 1); // 1 charged at subscribe, room for 1 more
        vm.warp(_sub(id).nextBillingAt);
        _collectAs(alice, id);
        assertEq(_sub(id).remainingCap, 1);
        vm.warp(_sub(id).nextBillingAt);
        (ISM.CollectionCheck c, uint128 amt) = manager.previewCollection(id, alice);
        assertEq(uint8(c), uint8(ISM.CollectionCheck.SpendCapExceeded));
        assertEq(amt, PRICE);
        vm.prank(alice);
        vm.expectRevert(ISM.SpendCapExceeded.selector);
        manager.collectPayment(id);
    }

    function test_collect_expiry() public {
        uint256 planId2 = _createPlan(_params(PRICE, MIN_INTERVAL));
        uint64 exp = uint64(block.timestamp + 2 * MIN_INTERVAL);
        vm.prank(carol);
        uint256 id = manager.subscribe(planId2, 1, 100e18, exp);
        vm.warp(_sub(id).nextBillingAt); // t + 300 < exp
        _collectAs(alice, id);
        vm.warp(_sub(id).nextBillingAt); // t + 600 == exp -> expired
        (ISM.CollectionCheck c,) = manager.previewCollection(id, alice);
        assertEq(uint8(c), uint8(ISM.CollectionCheck.AuthorizationExpired));
        vm.prank(alice);
        vm.expectRevert(ISM.AuthorizationExpired.selector);
        manager.collectPayment(id);

        // subscriber renews the expiry -> collectable again
        vm.prank(carol);
        manager.updateAuthorization(id, 100e18, 0);
        _collectAs(alice, id);
    }

    function test_collect_insufficientAllowance_noStateChange() public {
        vm.prank(bob);
        musd.approve(address(manager), PRICE - 1);
        vm.warp(_sub(subId).nextBillingAt);
        bytes32 snap = _snapshot();
        uint256 payoutBefore = musd.balanceOf(payout);
        vm.prank(alice);
        vm.expectRevert(ISM.InsufficientAllowance.selector);
        manager.collectPayment(subId);
        assertEq(_snapshot(), snap);
        assertEq(musd.balanceOf(payout), payoutBefore);
    }

    function test_collect_insufficientBalance_noStateChange() public {
        vm.startPrank(bob);
        musd.transfer(mallory, musd.balanceOf(bob) - (PRICE - 1));
        vm.stopPrank();
        vm.warp(_sub(subId).nextBillingAt);
        bytes32 snap = _snapshot();
        vm.prank(keeper);
        vm.expectRevert(ISM.InsufficientBalance.selector);
        manager.collectPayment(subId);
        assertEq(_snapshot(), snap);
    }

    function test_collect_failedPaymentDoesNotAdvanceSchedule_thenRecovers() public {
        uint64 due = _sub(subId).nextBillingAt;
        vm.prank(bob);
        musd.approve(address(manager), 0);
        vm.warp(due + 1 days);
        vm.prank(alice);
        vm.expectRevert(ISM.InsufficientAllowance.selector);
        manager.collectPayment(subId);
        assertEq(_sub(subId).nextBillingAt, due);
        assertEq(_sub(subId).paymentsCount, 1);

        // subscriber re-approves; retry succeeds for the same period
        vm.prank(bob);
        musd.approve(address(manager), 100e18);
        _collectAs(alice, subId);
        assertEq(_sub(subId).paymentsCount, 2);
        assertEq(_sub(subId).nextBillingAt, block.timestamp + MONTH);
    }

    // ------------------------------------------------------------------ payout + merchant/global state

    function test_collect_payoutChangeAppliesToFutureCollections() public {
        address newPayout = makeAddr("newPayout");
        vm.prank(alice);
        registry.setPayout(merchantId, newPayout);
        vm.warp(_sub(subId).nextBillingAt);
        _collectAs(alice, subId);
        assertEq(musd.balanceOf(newPayout), PRICE);
        assertEq(musd.balanceOf(payout), PRICE); // only the original subscribe charge
    }

    function test_merchantPause_blocksCollectAndSubscribe_notCancel() public {
        vm.prank(alice);
        registry.pauseMerchant(merchantId);
        vm.warp(_sub(subId).nextBillingAt);

        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.MerchantInactive));
        vm.prank(alice);
        vm.expectRevert(ISM.MerchantNotActive.selector);
        manager.collectPayment(subId);

        vm.prank(carol);
        vm.expectRevert(ISM.MerchantNotActive.selector);
        manager.subscribe(planId, 1, 100e18, 0);

        vm.prank(bob);
        manager.cancelSubscription(subId);
        assertEq(uint8(_sub(subId).status), uint8(ISM.SubscriptionStatus.Cancelled));
    }

    function test_merchantSuspended_blocksCollect_cancelStillWorks() public {
        vm.prank(admin);
        registry.suspendMerchant(merchantId);
        vm.warp(_sub(subId).nextBillingAt);
        vm.prank(keeper);
        vm.expectRevert(ISM.MerchantNotActive.selector);
        manager.collectPayment(subId);
        vm.prank(alice); // merchant may still cancel
        manager.cancelSubscription(subId);
    }

    function test_globalPause() public {
        vm.prank(admin);
        manager.pause();
        vm.warp(_sub(subId).nextBillingAt);

        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.ContractPaused));
        // an unauthorized caller still sees NotAuthorized first (check order)
        assertEq(uint8(_check(mallory)), uint8(ISM.CollectionCheck.NotAuthorized));
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        manager.collectPayment(subId);

        // subscriber controls keep working while paused
        vm.startPrank(bob);
        manager.updateAuthorization(subId, 50e18, 0);
        manager.cancelSubscription(subId);
        vm.stopPrank();

        vm.prank(admin);
        manager.unpause();
        uint256 id2 = _subscribe(carol, planId, 100e18);
        assertGt(id2, 0);
    }

    function test_checkOrder() public {
        // Several failures at once: the first in the documented order wins.
        vm.prank(alice);
        registry.pauseMerchant(merchantId);
        vm.prank(admin);
        manager.pause();
        // not due + merchant inactive + paused + unauthorized
        assertEq(uint8(_check(mallory)), uint8(ISM.CollectionCheck.NotAuthorized));
        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.MerchantInactive));
        vm.prank(alice);
        registry.resumeMerchant(merchantId);
        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.ContractPaused));
        vm.prank(admin);
        manager.unpause();
        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.NotDue));
        // expired + cap + funding problems: expiry first
        vm.prank(bob);
        manager.updateAuthorization(subId, 0, uint64(block.timestamp + 1));
        vm.prank(bob);
        musd.approve(address(manager), 0);
        vm.warp(_sub(subId).nextBillingAt);
        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.AuthorizationExpired));
        vm.prank(bob);
        manager.updateAuthorization(subId, 0, 0);
        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.SpendCapExceeded));
        vm.prank(bob);
        manager.updateAuthorization(subId, 100e18, 0);
        uint256 bobBal = musd.balanceOf(bob);
        vm.prank(bob);
        musd.transfer(mallory, bobBal);
        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.InsufficientBalance));
        vm.prank(mallory);
        musd.transfer(bob, 100e18);
        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.InsufficientAllowance));
        vm.prank(bob);
        musd.approve(address(manager), PRICE);
        assertEq(uint8(_check(alice)), uint8(ISM.CollectionCheck.Ok));
    }

    // ------------------------------------------------------------------ reentrancy

    function test_reentrancy_collectBlocked() public {
        ReentrantToken rt = new ReentrantToken();
        vm.prank(admin);
        manager.setTokenAllowed(address(rt), true);
        ISM.PlanParams memory p = _params(PRICE, MIN_INTERVAL);
        p.token = address(rt);
        uint256 pid = _createPlan(p);
        rt.mint(carol, 100e18);
        vm.prank(carol);
        rt.approve(address(manager), type(uint256).max);
        uint256 id = _subscribe(carol, pid, 100e18);

        vm.warp(_sub(id).nextBillingAt);
        // during the transfer, the token tries to collect the same period again
        rt.arm(address(manager), abi.encodeCall(manager.collectPayment, (id)));
        _collectAs(alice, id);

        assertTrue(rt.reentryAttempted());
        assertFalse(rt.reentrySucceeded());
        assertEq(bytes4(rt.reentryRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(rt.balanceOf(payout), 2 * PRICE); // exactly two charges total (subscribe + one collect)
        assertEq(_sub(id).paymentsCount, 2);
    }

    function test_reentrancy_batchBlocked() public {
        ReentrantToken rt = new ReentrantToken();
        vm.prank(admin);
        manager.setTokenAllowed(address(rt), true);
        ISM.PlanParams memory p = _params(PRICE, MIN_INTERVAL);
        p.token = address(rt);
        uint256 pid = _createPlan(p);
        rt.mint(carol, 100e18);
        vm.prank(carol);
        rt.approve(address(manager), type(uint256).max);
        uint256 id = _subscribe(carol, pid, 100e18);
        vm.warp(_sub(id).nextBillingAt);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        rt.arm(address(manager), abi.encodeCall(manager.collectDuePayments, (ids)));
        vm.prank(keeper);
        assertEq(manager.collectDuePayments(ids), 1);
        assertFalse(rt.reentrySucceeded());
        assertEq(_sub(id).paymentsCount, 2);
    }
}
