// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {ISubscriptionManager} from "../src/interfaces/ISubscriptionManager.sol";
import {IMerchantRegistry} from "../src/interfaces/IMerchantRegistry.sol";
import {MockMUSD} from "./mocks/MockMUSD.sol";

/// @notice Shared fixture: registry, manager (MIN_INTERVAL = 300), MUSD mock, one merchant (alice) with a
///         separate payout wallet, a keeper, and a funded subscriber (bob).
abstract contract BaseTest is Test {
    uint32 internal constant MIN_INTERVAL = 300;
    uint32 internal constant MONTH = 30 days;
    uint128 internal constant PRICE = 10e18;

    MerchantRegistry internal registry;
    SubscriptionManager internal manager;
    MockMUSD internal musd;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice"); // merchant owner
    address internal payout = makeAddr("payout");
    address internal keeper = makeAddr("keeper");
    address internal bob = makeAddr("bob"); // subscriber
    address internal carol = makeAddr("carol"); // second subscriber
    address internal mallory = makeAddr("mallory");

    uint256 internal merchantId;

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        registry = new MerchantRegistry(admin);
        manager = new SubscriptionManager(address(registry), admin, MIN_INTERVAL);
        musd = new MockMUSD();

        vm.startPrank(admin);
        manager.setTokenAllowed(address(musd), true);
        manager.grantRole(manager.KEEPER_ROLE(), keeper);
        vm.stopPrank();

        vm.prank(alice);
        merchantId = registry.registerMerchant(payout, "mezosub:merchant:alice");

        _fund(bob, 1_000e18, type(uint256).max);
        _fund(carol, 1_000e18, type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _fund(address who, uint256 amount, uint256 allowance) internal {
        musd.mint(who, amount);
        vm.prank(who);
        musd.approve(address(manager), allowance);
    }

    function _params(uint128 amount, uint32 interval) internal view returns (ISubscriptionManager.PlanParams memory p) {
        p = ISubscriptionManager.PlanParams({
            token: address(musd),
            amount: amount,
            interval: interval,
            trialPeriod: 0,
            introAmount: 0,
            introPeriods: 0,
            maxSubscribers: 0
        });
    }

    function _createPlan(ISubscriptionManager.PlanParams memory p) internal returns (uint256 planId) {
        vm.prank(alice);
        planId = manager.createPlan(p);
    }

    /// @dev Monthly PRICE plan, no trial, no intro.
    function _basicPlan() internal returns (uint256) {
        return _createPlan(_params(PRICE, MONTH));
    }

    function _subscribe(address who, uint256 planId, uint128 cap) internal returns (uint256 subId) {
        uint32 v = manager.getPlan(planId).termsVersion;
        vm.prank(who);
        subId = manager.subscribe(planId, v, cap, 0);
    }

    function _sub(uint256 id) internal view returns (ISubscriptionManager.Subscription memory) {
        return manager.getSubscription(id);
    }

    function _collectAs(address who, uint256 id) internal returns (uint128) {
        vm.prank(who);
        return manager.collectPayment(id);
    }

    function _warpTo(uint256 ts) internal {
        vm.warp(ts);
    }
}
