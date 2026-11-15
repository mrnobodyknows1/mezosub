// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {SubscriptionManager} from "../../src/SubscriptionManager.sol";
import {ISubscriptionManager as ISM} from "../../src/interfaces/ISubscriptionManager.sol";
import {MockMUSD} from "../mocks/MockMUSD.sol";

/// @notice Drives random subscribe / collect / batch / cancel / revoke / updateAuthorization / approve / warp
///         sequences and records ghost state the invariants are checked against.
contract Handler is Test {
    bytes32 internal constant COLLECTED_SIG =
        keccak256("PaymentCollected(uint256,uint256,address,address,address,uint128,uint32,uint64,uint64,address)");
    uint256 internal constant MAX_SUBS = 40;

    SubscriptionManager public manager;
    MockMUSD public musd;
    address public merchantOwner;
    address public keeper;
    uint256[] public planIds;
    address[] public actors;

    uint256[] public subIds;

    /// @notice Sum of every PaymentCollected amount ever emitted.
    uint256 public ghostCollected;
    /// @notice Set if any action other than updateAuthorization increased a subscription's remainingCap.
    bool public capIncreased;
    /// @notice Set if a cancelled subscription ever gained a payment.
    bool public cancelledGainedPayment;

    mapping(bytes32 => uint256) public calls;

    constructor(
        SubscriptionManager manager_,
        MockMUSD musd_,
        address merchantOwner_,
        address keeper_,
        uint256[] memory planIds_,
        address[] memory actors_
    ) {
        manager = manager_;
        musd = musd_;
        merchantOwner = merchantOwner_;
        keeper = keeper_;
        planIds = planIds_;
        actors = actors_;
    }

    function subCount() external view returns (uint256) {
        return subIds.length;
    }

    // ------------------------------------------------------------------ ghost bookkeeping

    struct Snap {
        uint128 cap;
        uint32 payments;
        bool cancelled;
    }

    function _snapshot() internal view returns (Snap[] memory snaps) {
        snaps = new Snap[](subIds.length);
        for (uint256 i = 0; i < subIds.length; ++i) {
            ISM.Subscription memory s = manager.getSubscription(subIds[i]);
            snaps[i] = Snap(s.remainingCap, s.paymentsCount, s.status == ISM.SubscriptionStatus.Cancelled);
        }
    }

    /// @dev Compares against the pre-action snapshot. `exempt` = sub id whose cap may legally rise.
    function _verify(Snap[] memory before, uint256 exempt) internal {
        for (uint256 i = 0; i < before.length; ++i) {
            ISM.Subscription memory s = manager.getSubscription(subIds[i]);
            if (subIds[i] != exempt && s.remainingCap > before[i].cap) capIncreased = true;
            if (before[i].cancelled && s.paymentsCount != before[i].payments) cancelledGainedPayment = true;
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(manager) && logs[i].topics[0] == COLLECTED_SIG) {
                (,, uint128 amount,,,,) =
                    abi.decode(logs[i].data, (address, address, uint128, uint32, uint64, uint64, address));
                ghostCollected += amount;
            }
        }
    }

    function _pickSub(uint256 seed) internal view returns (uint256) {
        return subIds[seed % subIds.length];
    }

    // ------------------------------------------------------------------ actions

    function subscribe(uint256 actorSeed, uint256 planSeed, uint128 cap) external {
        if (subIds.length >= MAX_SUBS) return;
        address actor = actors[actorSeed % actors.length];
        uint256 planId = planIds[planSeed % planIds.length];
        cap = uint128(bound(cap, 1e18, 200e18));
        uint32 v = manager.getPlan(planId).termsVersion;

        Snap[] memory before = _snapshot();
        vm.recordLogs();
        vm.prank(actor);
        try manager.subscribe(planId, v, cap, 0) returns (uint256 id) {
            subIds.push(id);
            calls["subscribe.ok"]++;
        } catch {
            calls["subscribe.fail"]++;
        }
        _verify(before, 0);
    }

    function collect(uint256 subSeed, bool asKeeper, bool warpToDue) external {
        if (subIds.length == 0) return;
        uint256 id = _pickSub(subSeed);
        // Usually jump to the due time so successful collections are common; sometimes try early.
        uint64 due = manager.getSubscription(id).nextBillingAt;
        if (warpToDue && due > block.timestamp) vm.warp(due);
        Snap[] memory before = _snapshot();
        vm.recordLogs();
        vm.prank(asKeeper ? keeper : merchantOwner);
        try manager.collectPayment(id) {
            calls["collect.ok"]++;
        } catch {
            calls["collect.fail"]++;
        }
        _verify(before, 0);
    }

    function collectBatch(uint256 seed, uint8 len, uint32 dt) external {
        if (subIds.length == 0) return;
        vm.warp(block.timestamp + bound(dt, 0, 31 days));
        len = uint8(bound(len, 1, 10));
        uint256[] memory ids = new uint256[](len);
        for (uint256 i = 0; i < len; ++i) {
            ids[i] = _pickSub(uint256(keccak256(abi.encode(seed, i))));
        }
        Snap[] memory before = _snapshot();
        vm.recordLogs();
        vm.prank(keeper);
        uint256 n = manager.collectDuePayments(ids); // must never revert (no try/catch on purpose)
        calls["batch.collected"] += n;
        _verify(before, 0);
    }

    function cancel(uint256 subSeed, bool byMerchant) external {
        if (subIds.length == 0 || subSeed % 4 != 0) return; // keep most subscriptions alive
        uint256 id = _pickSub(subSeed / 4);
        address who = byMerchant ? merchantOwner : manager.getSubscription(id).subscriber;
        Snap[] memory before = _snapshot();
        vm.recordLogs();
        vm.prank(who);
        try manager.cancelSubscription(id) {
            calls["cancel.ok"]++;
        } catch {}
        _verify(before, 0);
    }

    function revoke(uint256 subSeed) external {
        if (subIds.length == 0 || subSeed % 4 != 0) return;
        uint256 id = _pickSub(subSeed / 4);
        address who = manager.getSubscription(id).subscriber;
        Snap[] memory before = _snapshot();
        vm.recordLogs();
        vm.prank(who);
        manager.revokeAuthorization(id);
        calls["revoke"]++;
        _verify(before, 0);
    }

    function updateAuthorization(uint256 subSeed, uint128 cap) external {
        if (subIds.length == 0) return;
        uint256 id = _pickSub(subSeed);
        cap = uint128(bound(cap, 0, 200e18));
        address who = manager.getSubscription(id).subscriber;
        Snap[] memory before = _snapshot();
        vm.recordLogs();
        vm.prank(who);
        try manager.updateAuthorization(id, cap, 0) {
            calls["updateAuth.ok"]++;
        } catch {}
        _verify(before, id);
    }

    function setAllowance(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 0, 300e18);
        vm.prank(actor);
        musd.approve(address(manager), amount);
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 45 days));
    }
}
