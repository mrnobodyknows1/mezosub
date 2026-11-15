// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ISubscriptionManager as ISM} from "../src/interfaces/ISubscriptionManager.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract PlansTest is BaseTest {
    event PlanCreated(
        uint256 indexed planId,
        uint256 indexed merchantId,
        address token,
        uint128 amount,
        uint32 interval,
        uint32 trialPeriod,
        uint128 introAmount,
        uint16 introPeriods,
        uint32 maxSubscribers
    );

    function test_constructor_validation() public {
        vm.expectRevert(SubscriptionManager.InvalidConfig.selector);
        new SubscriptionManager(address(registry), admin, 0);
        vm.expectRevert(SubscriptionManager.InvalidConfig.selector);
        new SubscriptionManager(address(registry), admin, 366 days + 1);
        vm.expectRevert(SubscriptionManager.InvalidConfig.selector);
        new SubscriptionManager(address(0), admin, 300);
        vm.expectRevert(SubscriptionManager.InvalidConfig.selector);
        new SubscriptionManager(address(registry), address(0), 300);

        SubscriptionManager m = new SubscriptionManager(address(registry), admin, 366 days);
        assertEq(m.MIN_INTERVAL(), 366 days);
    }

    function test_constants() public view {
        assertEq(manager.MIN_INTERVAL(), 300);
        assertEq(manager.MAX_INTERVAL(), 366 days);
        assertEq(manager.MAX_BATCH(), 50);
        assertEq(manager.KEEPER_ROLE(), keccak256("KEEPER_ROLE"));
        assertEq(manager.registry(), address(registry));
        assertTrue(manager.isTokenAllowed(address(musd)));
    }

    function test_admin_onlyAdmin() public {
        vm.startPrank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, bytes32(0))
        );
        manager.setTokenAllowed(address(musd), false);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, bytes32(0))
        );
        manager.pause();
        vm.stopPrank();

        vm.prank(admin);
        vm.expectRevert(ISM.TokenNotAllowed.selector);
        manager.setTokenAllowed(address(0), true);
    }

    function test_createPlan_happy() public {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.trialPeriod = 7 days;
        p.introAmount = 1e18;
        p.introPeriods = 2;
        p.maxSubscribers = 5;

        vm.expectEmit(address(manager));
        emit PlanCreated(1, merchantId, address(musd), PRICE, MONTH, 7 days, 1e18, 2, 5);
        uint256 id = _createPlan(p);
        assertEq(id, 1);

        ISM.Plan memory plan = manager.getPlan(id);
        assertEq(plan.merchantId, merchantId);
        assertEq(plan.token, address(musd));
        assertEq(plan.amount, PRICE);
        assertEq(plan.introAmount, 1e18);
        assertEq(plan.interval, MONTH);
        assertEq(plan.trialPeriod, 7 days);
        assertEq(plan.introPeriods, 2);
        assertEq(plan.maxSubscribers, 5);
        assertEq(plan.activeSubscribers, 0);
        assertEq(plan.termsVersion, 1);
        assertEq(uint8(plan.status), uint8(ISM.PlanStatus.Active));
        assertEq(plan.createdAt, block.timestamp);
        assertEq(manager.planCount(), 1);
    }

    function test_createPlan_requiresMerchant() public {
        vm.prank(mallory);
        vm.expectRevert(ISM.NotMerchantOwner.selector);
        manager.createPlan(_params(PRICE, MONTH));
    }

    function test_createPlan_requiresActiveMerchant() public {
        vm.prank(alice);
        registry.pauseMerchant(merchantId);
        vm.prank(alice);
        vm.expectRevert(ISM.MerchantNotActive.selector);
        manager.createPlan(_params(PRICE, MONTH));
    }

    function test_createPlan_requiresAllowedToken() public {
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.token = address(0xBEEF);
        vm.prank(alice);
        vm.expectRevert(ISM.TokenNotAllowed.selector);
        manager.createPlan(p);
    }

    function _expectInvalid(ISM.PlanParams memory p) internal {
        vm.prank(alice);
        vm.expectRevert(ISM.InvalidPlanParams.selector);
        manager.createPlan(p);
    }

    function test_createPlan_validation() public {
        _expectInvalid(_params(0, MONTH)); // zero amount
        _expectInvalid(_params(PRICE, MIN_INTERVAL - 1)); // interval too short
        _expectInvalid(_params(PRICE, 366 days + 1)); // interval too long

        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.trialPeriod = 366 days + 1;
        _expectInvalid(p);

        p = _params(PRICE, MONTH);
        p.introPeriods = 1; // introAmount 0
        _expectInvalid(p);

        p = _params(PRICE, MONTH);
        p.introPeriods = 1;
        p.introAmount = PRICE; // must be < amount
        _expectInvalid(p);

        p = _params(PRICE, MONTH);
        p.introAmount = 1e18; // introAmount without introPeriods
        _expectInvalid(p);

        // boundaries accepted
        _createPlan(_params(1, MIN_INTERVAL));
        p = _params(PRICE, 366 days);
        p.trialPeriod = 366 days;
        p.introPeriods = 1;
        p.introAmount = PRICE - 1;
        _createPlan(p);
    }

    function test_updatePlan_bumpsVersion_andOnlyFutureSubs() public {
        uint256 planId = _basicPlan();
        uint256 subId = _subscribe(bob, planId, 100e18);

        ISM.PlanParams memory p = _params(20e18, 7 days);
        p.maxSubscribers = 3;
        vm.prank(alice);
        manager.updatePlan(planId, p);

        ISM.Plan memory plan = manager.getPlan(planId);
        assertEq(plan.termsVersion, 2);
        assertEq(plan.amount, 20e18);
        assertEq(plan.interval, 7 days);

        // existing subscription keeps its snapshot
        ISM.Subscription memory s = _sub(subId);
        assertEq(s.amount, PRICE);
        assertEq(s.interval, MONTH);
        assertEq(s.termsVersion, 1);

        vm.warp(s.nextBillingAt);
        uint256 before = musd.balanceOf(payout);
        _collectAs(alice, subId);
        assertEq(musd.balanceOf(payout) - before, PRICE);
        assertEq(_sub(subId).nextBillingAt, s.nextBillingAt + MONTH);

        // new subscriber gets new terms
        uint256 sub2 = _subscribe(carol, planId, 100e18);
        assertEq(_sub(sub2).amount, 20e18);
        assertEq(_sub(sub2).termsVersion, 2);
    }

    function test_updatePlan_rules() public {
        uint256 planId = _basicPlan();

        vm.prank(mallory);
        vm.expectRevert(ISM.NotPlanMerchant.selector);
        manager.updatePlan(planId, _params(PRICE, MONTH));

        vm.prank(alice);
        vm.expectRevert(ISM.PlanNotFound.selector);
        manager.updatePlan(99, _params(PRICE, MONTH));

        // token cannot change
        ISM.PlanParams memory p = _params(PRICE, MONTH);
        p.token = address(0xBEEF);
        vm.prank(alice);
        vm.expectRevert(ISM.InvalidPlanParams.selector);
        manager.updatePlan(planId, p);

        // validation applies
        vm.prank(alice);
        vm.expectRevert(ISM.InvalidPlanParams.selector);
        manager.updatePlan(planId, _params(0, MONTH));

        // maxSubscribers below active count
        _subscribe(bob, planId, 100e18);
        _subscribe(carol, planId, 100e18);
        p = _params(PRICE, MONTH);
        p.maxSubscribers = 1;
        vm.prank(alice);
        vm.expectRevert(ISM.InvalidPlanParams.selector);
        manager.updatePlan(planId, p);
        p.maxSubscribers = 2; // == active is fine
        vm.prank(alice);
        manager.updatePlan(planId, p);
        p.maxSubscribers = 0; // unlimited is fine
        vm.prank(alice);
        manager.updatePlan(planId, p);

        // allowed while paused, not while archived
        vm.startPrank(alice);
        manager.pausePlan(planId);
        manager.updatePlan(planId, p);
        manager.archivePlan(planId);
        vm.expectRevert(ISM.InvalidStatusTransition.selector);
        manager.updatePlan(planId, p);
        vm.stopPrank();
        assertEq(manager.getPlan(planId).termsVersion, 4);
    }

    function test_planStatusTransitions() public {
        uint256 planId = _basicPlan();

        vm.prank(mallory);
        vm.expectRevert(ISM.NotPlanMerchant.selector);
        manager.pausePlan(planId);

        vm.startPrank(alice);
        vm.expectRevert(ISM.InvalidStatusTransition.selector);
        manager.resumePlan(planId);
        manager.pausePlan(planId);
        vm.expectRevert(ISM.InvalidStatusTransition.selector);
        manager.pausePlan(planId);
        manager.resumePlan(planId);
        manager.archivePlan(planId);
        vm.expectRevert(ISM.InvalidStatusTransition.selector);
        manager.archivePlan(planId);
        vm.expectRevert(ISM.InvalidStatusTransition.selector);
        manager.resumePlan(planId);
        vm.stopPrank();
        assertEq(uint8(manager.getPlan(planId).status), uint8(ISM.PlanStatus.Archived));
    }

    function test_pausedAndArchivedPlans_keepBilling() public {
        uint256 planId = _basicPlan();
        uint256 subId = _subscribe(bob, planId, 100e18);

        vm.prank(alice);
        manager.pausePlan(planId);
        vm.prank(carol);
        vm.expectRevert(ISM.PlanNotActive.selector);
        manager.subscribe(planId, 1, 100e18, 0);

        vm.warp(_sub(subId).nextBillingAt);
        _collectAs(alice, subId);

        vm.prank(alice);
        manager.archivePlan(planId);
        vm.warp(_sub(subId).nextBillingAt);
        _collectAs(alice, subId);
        assertEq(_sub(subId).paymentsCount, 3);
    }

    function test_planOps_followMerchantOwnershipTransfer() public {
        uint256 planId = _basicPlan();
        vm.prank(alice);
        registry.transferMerchantOwnership(merchantId, carol);

        vm.prank(alice);
        vm.expectRevert(ISM.NotPlanMerchant.selector);
        manager.pausePlan(planId);
        vm.prank(carol);
        manager.pausePlan(planId);
    }
}
