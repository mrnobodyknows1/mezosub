// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MerchantRegistry} from "../../src/MerchantRegistry.sol";
import {SubscriptionManager} from "../../src/SubscriptionManager.sol";
import {ISubscriptionManager as ISM} from "../../src/interfaces/ISubscriptionManager.sol";
import {MockMUSD} from "../mocks/MockMUSD.sol";
import {Handler} from "./Handler.sol";

contract InvariantTest is Test {
    MerchantRegistry internal registry;
    SubscriptionManager internal manager;
    MockMUSD internal musd;
    Handler internal handler;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal payout = makeAddr("payout");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        vm.warp(1_750_000_000);
        registry = new MerchantRegistry(admin);
        manager = new SubscriptionManager(address(registry), admin, 300);
        musd = new MockMUSD();
        vm.startPrank(admin);
        manager.setTokenAllowed(address(musd), true);
        manager.grantRole(manager.KEEPER_ROLE(), keeper);
        vm.stopPrank();

        vm.prank(owner);
        registry.registerMerchant(payout, "m");

        uint256[] memory planIds = new uint256[](3);
        vm.startPrank(owner);
        // plain monthly
        planIds[0] = manager.createPlan(
            ISM.PlanParams({
                token: address(musd),
                amount: 10e18,
                interval: 30 days,
                trialPeriod: 0,
                introAmount: 0,
                introPeriods: 0,
                maxSubscribers: 0
            })
        );
        // intro pricing, short interval
        planIds[1] = manager.createPlan(
            ISM.PlanParams({
                token: address(musd),
                amount: 7e18,
                interval: 1 days,
                trialPeriod: 0,
                introAmount: 1e18,
                introPeriods: 3,
                maxSubscribers: 0
            })
        );
        // trial + intro
        planIds[2] = manager.createPlan(
            ISM.PlanParams({
                token: address(musd),
                amount: 5e18,
                interval: 7 days,
                trialPeriod: 3 days,
                introAmount: 2e18,
                introPeriods: 1,
                maxSubscribers: 0
            })
        );
        vm.stopPrank();

        address[] memory actors = new address[](6);
        for (uint256 i = 0; i < actors.length; ++i) {
            actors[i] = address(uint160(0xA000 + i));
            musd.mint(actors[i], 1_000e18);
            vm.prank(actors[i]);
            musd.approve(address(manager), 500e18);
        }

        handler = new Handler(manager, musd, owner, keeper, planIds, actors);
        targetContract(address(handler));
    }

    /// Payout balance equals the sum of every PaymentCollected amount (no refunds in this suite).
    function invariant_payoutEqualsCollectedEvents() public view {
        assertEq(musd.balanceOf(payout), handler.ghostCollected());
    }

    /// The manager never holds tokens.
    function invariant_managerHoldsNothing() public view {
        assertEq(musd.balanceOf(address(manager)), 0);
    }

    /// For every subscription, totalPaid == Σ period amounts over paymentsCount periods, and
    /// Σ totalPaid == payout balance.
    function invariant_totalPaidMatchesSchedule() public view {
        uint256 sum;
        uint256 n = handler.subCount();
        for (uint256 i = 0; i < n; ++i) {
            ISM.Subscription memory s = manager.getSubscription(handler.subIds(i));
            uint256 expected;
            for (uint256 k = 0; k < s.paymentsCount; ++k) {
                expected += k < s.introPeriods ? s.introAmount : s.amount;
            }
            assertEq(s.totalPaid, expected);
            sum += s.totalPaid;
        }
        assertEq(sum, musd.balanceOf(payout));
    }

    /// remainingCap only rises through updateAuthorization.
    function invariant_capNeverIncreasesOtherwise() public view {
        assertFalse(handler.capIncreased());
    }

    /// Cancelled subscriptions never gain payments.
    function invariant_cancelledNeverPaid() public view {
        assertFalse(handler.cancelledGainedPayment());
    }

    /// Plan activeSubscribers equals the number of Active subscriptions on that plan; activeSubscriptionOf agrees.
    function invariant_activeCounters() public view {
        uint256 n = handler.subCount();
        uint256[4] memory active;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = handler.subIds(i);
            ISM.Subscription memory s = manager.getSubscription(id);
            if (s.status == ISM.SubscriptionStatus.Active) {
                active[s.planId]++;
                assertEq(manager.activeSubscriptionOf(s.planId, s.subscriber), id);
            }
        }
        for (uint256 p = 1; p <= 3; ++p) {
            assertEq(manager.getPlan(p).activeSubscribers, active[p]);
        }
    }

    /// An Active subscription's next billing time is never more than one interval/trial past its last payment
    /// anchor: no back-billing means nextBillingAt > lastPaymentAt.
    function invariant_scheduleMonotonic() public view {
        uint256 n = handler.subCount();
        for (uint256 i = 0; i < n; ++i) {
            ISM.Subscription memory s = manager.getSubscription(handler.subIds(i));
            if (s.paymentsCount > 0) assertGt(s.nextBillingAt, s.lastPaymentAt);
        }
    }
}
