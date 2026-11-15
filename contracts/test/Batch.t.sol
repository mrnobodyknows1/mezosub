// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISubscriptionManager as ISM} from "../src/interfaces/ISubscriptionManager.sol";
import {FalseReturnToken} from "./mocks/FalseReturnToken.sol";
import {Vm} from "forge-std/Vm.sol";

contract BatchTest is BaseTest {
    event PaymentFailed(
        uint256 indexed subscriptionId,
        uint32 periodIndex,
        ISM.CollectionCheck reason,
        uint128 amount,
        address collector
    );
    event CollectionSkipped(uint256 indexed subscriptionId, ISM.CollectionCheck reason);

    bytes32 internal constant COLLECTED_SIG =
        keccak256("PaymentCollected(uint256,uint256,address,address,address,uint128,uint32,uint64,uint64,address)");

    function test_batch_tooLarge() public {
        uint256[] memory ids = new uint256[](51);
        vm.prank(keeper);
        vm.expectRevert(ISM.BatchTooLarge.selector);
        manager.collectDuePayments(ids);

        ids = new uint256[](0);
        vm.prank(keeper);
        assertEq(manager.collectDuePayments(ids), 0);
    }

    function test_batch_mixed() public {
        uint256 planId = _basicPlan();
        address dave = makeAddr("dave");
        address erin = makeAddr("erin");
        address frank = makeAddr("frank");
        _fund(dave, 100e18, type(uint256).max);
        _fund(erin, 100e18, type(uint256).max);
        _fund(frank, 100e18, type(uint256).max);

        uint256 okA = _subscribe(bob, planId, 100e18);
        uint256 okB = _subscribe(carol, planId, 100e18);
        uint256 noAllowance = _subscribe(dave, planId, 100e18);
        uint256 cancelled = _subscribe(erin, planId, 100e18);
        uint256 noBalance = _subscribe(frank, planId, 100e18);

        vm.prank(dave);
        musd.approve(address(manager), 0);
        vm.prank(erin);
        manager.cancelSubscription(cancelled);
        uint256 frankBal = musd.balanceOf(frank);
        vm.prank(frank);
        musd.transfer(mallory, frankBal);

        vm.warp(block.timestamp + MONTH);

        uint256[] memory ids = new uint256[](7);
        ids[0] = okA;
        ids[1] = noAllowance;
        ids[2] = cancelled;
        ids[3] = 999; // unknown
        ids[4] = okB;
        ids[5] = noBalance;
        ids[6] = okA; // duplicate in the same batch -> NotDue

        uint64 nextNoAllowance = _sub(noAllowance).nextBillingAt;
        uint256 payoutBefore = musd.balanceOf(payout);

        vm.expectEmit(address(manager));
        emit PaymentFailed(noAllowance, 1, ISM.CollectionCheck.InsufficientAllowance, PRICE, keeper);
        vm.expectEmit(address(manager));
        emit CollectionSkipped(cancelled, ISM.CollectionCheck.NotActive);
        vm.expectEmit(address(manager));
        emit CollectionSkipped(999, ISM.CollectionCheck.NotFound);
        vm.expectEmit(address(manager));
        emit PaymentFailed(noBalance, 1, ISM.CollectionCheck.InsufficientBalance, PRICE, keeper);
        vm.expectEmit(address(manager));
        emit CollectionSkipped(okA, ISM.CollectionCheck.NotDue);

        vm.recordLogs();
        vm.prank(keeper);
        uint256 n = manager.collectDuePayments(ids);
        assertEq(n, 2);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 collected;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == COLLECTED_SIG) collected++;
        }
        assertEq(collected, 2);

        assertEq(musd.balanceOf(payout) - payoutBefore, 2 * PRICE);
        assertEq(_sub(okA).paymentsCount, 2);
        assertEq(_sub(okB).paymentsCount, 2);
        assertEq(_sub(noAllowance).paymentsCount, 1);
        assertEq(_sub(noAllowance).nextBillingAt, nextNoAllowance);
        assertEq(_sub(noBalance).paymentsCount, 1);
    }

    function test_batch_unauthorizedCallerSkipsEverything() public {
        uint256 planId = _basicPlan();
        uint256 id = _subscribe(bob, planId, 100e18);
        vm.warp(block.timestamp + MONTH);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.expectEmit(address(manager));
        emit CollectionSkipped(id, ISM.CollectionCheck.NotAuthorized);
        vm.prank(mallory);
        assertEq(manager.collectDuePayments(ids), 0);
        assertEq(_sub(id).paymentsCount, 1);
    }

    function test_batch_pausedSkips() public {
        uint256 planId = _basicPlan();
        uint256 id = _subscribe(bob, planId, 100e18);
        vm.warp(block.timestamp + MONTH);
        vm.prank(admin);
        manager.pause();
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.expectEmit(address(manager));
        emit CollectionSkipped(id, ISM.CollectionCheck.ContractPaused);
        vm.prank(keeper);
        assertEq(manager.collectDuePayments(ids), 0);
    }

    function _falseTokenSub() internal returns (FalseReturnToken ft, uint256 id) {
        ft = new FalseReturnToken();
        vm.prank(admin);
        manager.setTokenAllowed(address(ft), true);
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.token = address(ft);
        uint256 pid = _createPlan(p);
        ft.mint(bob, 100e18);
        vm.prank(bob);
        ft.approve(address(manager), type(uint256).max);
        id = _subscribe(bob, pid, 100e18);
    }

    function test_batch_transferReturnsFalse_restoresState() public {
        (FalseReturnToken ft, uint256 id) = _falseTokenSub();
        uint256 good = _subscribe(carol, _basicPlan(), 100e18);
        vm.warp(block.timestamp + MONTH);
        ft.setReturnFalse(true);

        bytes32 before = keccak256(abi.encode(_sub(id)));
        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = good;

        vm.expectEmit(address(manager));
        emit PaymentFailed(id, 1, ISM.CollectionCheck.TransferFailed, PRICE, keeper);
        vm.prank(keeper);
        assertEq(manager.collectDuePayments(ids), 1);

        assertEq(keccak256(abi.encode(_sub(id))), before); // fully restored
        assertEq(ft.balanceOf(payout), PRICE); // only the subscribe-time charge
        assertEq(_sub(good).paymentsCount, 2);

        // single collect with the same token reverts (SafeERC20) and leaves state unchanged
        vm.prank(alice);
        vm.expectRevert();
        manager.collectPayment(id);
        assertEq(keccak256(abi.encode(_sub(id))), before);

        // token recovers -> retry for the same period succeeds
        ft.setReturnFalse(false);
        vm.prank(keeper);
        assertEq(manager.collectDuePayments(ids), 1); // good is not due again; id collects
        assertEq(_sub(id).paymentsCount, 2);
    }

    function test_batch_transferReverts_restoresState() public {
        (FalseReturnToken ft, uint256 id) = _falseTokenSub();
        vm.warp(block.timestamp + MONTH);
        ft.setRevertOnTransfer(true);
        bytes32 before = keccak256(abi.encode(_sub(id)));
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.expectEmit(address(manager));
        emit PaymentFailed(id, 1, ISM.CollectionCheck.TransferFailed, PRICE, keeper);
        vm.prank(keeper);
        assertEq(manager.collectDuePayments(ids), 0);
        assertEq(keccak256(abi.encode(_sub(id))), before);
    }

    function test_batch_fullBatchOf50() public {
        uint256 planId = _basicPlan();
        uint256[] memory ids = new uint256[](50);
        for (uint256 i = 0; i < 50; ++i) {
            address s = address(uint160(0x10000 + i));
            _fund(s, 100e18, type(uint256).max);
            ids[i] = _subscribe(s, planId, 100e18);
        }
        vm.warp(block.timestamp + MONTH);
        uint256 before = musd.balanceOf(payout);
        vm.prank(keeper);
        uint256 n = manager.collectDuePayments(ids);
        assertEq(n, 50);
        assertEq(musd.balanceOf(payout) - before, 50 * uint256(PRICE));
    }
}
