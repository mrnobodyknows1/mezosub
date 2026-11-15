// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISubscriptionManager as ISM} from "../src/interfaces/ISubscriptionManager.sol";

contract FuzzTest is BaseTest {
    function testFuzz_collect_amountIntervalWarp(uint128 amount, uint32 interval, uint32 warpBy) public {
        amount = uint128(bound(amount, 1, 1e30));
        interval = uint32(bound(interval, MIN_INTERVAL, 366 days));
        warpBy = uint32(bound(warpBy, 0, 3 * 366 days));

        uint256 planId = _createPlan(_params(amount, interval));
        address sub = makeAddr("fuzzSub");
        _fund(sub, uint256(amount) * 2, type(uint256).max);
        uint256 id = _subscribe(sub, planId, amount * 2);
        assertEq(musd.balanceOf(payout), amount);

        uint64 due = _sub(id).nextBillingAt;
        assertEq(due, block.timestamp + interval);
        vm.warp(block.timestamp + warpBy);

        if (block.timestamp < due) {
            vm.prank(alice);
            vm.expectRevert(ISM.NotDue.selector);
            manager.collectPayment(id);
            return;
        }

        assertEq(_collectAs(alice, id), amount);
        assertEq(musd.balanceOf(payout), uint256(amount) * 2);
        assertEq(musd.balanceOf(address(manager)), 0);

        ISM.Subscription memory s = _sub(id);
        assertEq(s.paymentsCount, 2);
        assertEq(s.remainingCap, 0);
        assertGt(s.nextBillingAt, block.timestamp); // never immediately due again
        assertEq(s.nextBillingAt, uint64(block.timestamp) + interval); // a full interval after this charge

        // cap is exhausted: a further charge is impossible
        vm.warp(s.nextBillingAt);
        vm.prank(alice);
        vm.expectRevert(ISM.SpendCapExceeded.selector);
        manager.collectPayment(id);
    }

    function testFuzz_introSequence(uint128 intro, uint128 amount, uint16 introPeriods, uint8 collections) public {
        amount = uint128(bound(amount, 2, 1e24));
        intro = uint128(bound(intro, 1, amount - 1));
        introPeriods = uint16(bound(introPeriods, 1, 6));
        collections = uint8(bound(collections, 0, 10));

        ISM.PlanParams memory p = _params(amount, MIN_INTERVAL);
        p.introAmount = intro;
        p.introPeriods = introPeriods;
        uint256 planId = _createPlan(p);

        address sub = makeAddr("fuzzIntro");
        _fund(sub, uint256(amount) * 20, type(uint256).max);
        uint256 id = _subscribe(sub, planId, amount * 20);

        for (uint256 i = 0; i < collections; ++i) {
            vm.warp(_sub(id).nextBillingAt);
            _collectAs(keeper, id);
        }

        ISM.Subscription memory s = _sub(id);
        uint256 expected;
        for (uint256 i = 0; i < s.paymentsCount; ++i) {
            expected += i < introPeriods ? intro : amount;
        }
        assertEq(s.paymentsCount, uint256(collections) + 1);
        assertEq(s.totalPaid, expected);
        assertEq(musd.balanceOf(payout), expected);
        assertEq(s.remainingCap, uint256(amount) * 20 - expected);
    }

    function testFuzz_capBoundsTotalCharged(uint128 cap, uint8 attempts) public {
        cap = uint128(bound(cap, PRICE, 20 * PRICE));
        attempts = uint8(bound(attempts, 1, 30));
        uint256 planId = _createPlan(_params(PRICE, MIN_INTERVAL));
        uint256 id = _subscribe(bob, planId, cap);
        for (uint256 i = 0; i < attempts; ++i) {
            vm.warp(_sub(id).nextBillingAt);
            vm.prank(alice);
            try manager.collectPayment(id) {} catch {}
        }
        ISM.Subscription memory s = _sub(id);
        assertLe(s.totalPaid, cap);
        assertEq(s.totalPaid + s.remainingCap, cap);
        assertEq(musd.balanceOf(payout), s.totalPaid);
    }

    function testFuzz_pagination(uint8 n, uint256 offset, uint256 limit) public {
        n = uint8(bound(n, 0, 12));
        for (uint256 i = 0; i < n; ++i) {
            _createPlan(_params(PRICE, MONTH));
        }
        (uint256[] memory ids, uint256 total) = manager.getMerchantPlans(merchantId, offset, limit);
        assertEq(total, n);
        uint256 expectedLen = offset >= n ? 0 : (limit < n - offset ? limit : n - offset);
        assertEq(ids.length, expectedLen);
        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(ids[i], offset + i + 1);
        }
    }
}
