// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ISubscriptionManager} from "./interfaces/ISubscriptionManager.sol";
import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";
import {MerchantRegistry} from "./MerchantRegistry.sol";

/// @title SubscriptionManager
/// @notice Non-custodial recurring billing. Every charge is one `transferFrom(subscriber -> merchant.payout)`;
///         this contract never holds a token balance.
/// @dev Roles:
///      - DEFAULT_ADMIN_ROLE: allowlist tokens, pause/unpause, grant/revoke KEEPER_ROLE. Cannot move funds,
///        change terms or payouts.
///      - KEEPER_ROLE: may *trigger* collections for merchants that opted in (keeperEnabled). Amount, recipient
///        and timing are fixed by this contract.
///      All token-moving functions are nonReentrant and follow checks-effects-interactions.
contract SubscriptionManager is ISubscriptionManager, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ------------------------------------------------------------------ constants / immutables

    /// @inheritdoc ISubscriptionManager
    uint32 public constant MAX_INTERVAL = 366 days;
    /// @inheritdoc ISubscriptionManager
    uint256 public constant MAX_BATCH = 50;
    /// @inheritdoc ISubscriptionManager
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    /// @inheritdoc ISubscriptionManager
    uint32 public immutable MIN_INTERVAL;
    /// @inheritdoc ISubscriptionManager
    address public immutable registry;

    /// @notice Constructor argument validation failed (zero address or minInterval out of range).
    /// @dev Implementation-only error; not part of the frozen interface.
    error InvalidConfig();

    // ------------------------------------------------------------------ storage

    MerchantRegistry private immutable _registry;

    mapping(address => bool) private _allowedTokens;
    /// @dev planId => subscriber => has subscribed before. Trial and intro terms apply to the first subscription only.
    mapping(uint256 => mapping(address => bool)) private _hasSubscribed;

    mapping(uint256 => Plan) private _plans;
    uint256 private _planCount;

    mapping(uint256 => Subscription) private _subs;
    uint256 private _subCount;

    /// @dev planId => subscriber => active subscription id (0 = none).
    mapping(uint256 => mapping(address => uint256)) private _activeSubOf;

    mapping(address => uint256[]) private _subscriberSubs;
    mapping(uint256 => uint256[]) private _merchantSubs;
    mapping(uint256 => uint256[]) private _merchantPlans;

    /// @dev Merchant fields needed for a collection, read from the registry once per check.
    struct MerchantInfo {
        address owner;
        address payout;
        IMerchantRegistry.MerchantStatus status;
        bool keeperEnabled;
    }

    // ------------------------------------------------------------------ constructor

    /// @param registry_ MerchantRegistry address.
    /// @param admin Receives DEFAULT_ADMIN_ROLE.
    /// @param minInterval Shortest allowed billing interval in seconds (testnet: 300). 0 < minInterval <= MAX_INTERVAL.
    constructor(address registry_, address admin, uint32 minInterval) {
        if (registry_ == address(0) || admin == address(0)) revert InvalidConfig();
        if (minInterval == 0 || minInterval > MAX_INTERVAL) revert InvalidConfig();
        registry = registry_;
        _registry = MerchantRegistry(registry_);
        MIN_INTERVAL = minInterval;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ================================================================== admin

    /// @inheritdoc ISubscriptionManager
    function setTokenAllowed(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert TokenNotAllowed();
        _allowedTokens[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @inheritdoc ISubscriptionManager
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @inheritdoc ISubscriptionManager
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ================================================================== merchant: plans

    /// @inheritdoc ISubscriptionManager
    function createPlan(PlanParams calldata p) external returns (uint256 planId) {
        uint256 merchantId = _registry.merchantIdOf(msg.sender);
        if (merchantId == 0) revert NotMerchantOwner();
        if (!_registry.isActive(merchantId)) revert MerchantNotActive();
        if (!_allowedTokens[p.token]) revert TokenNotAllowed();
        _validatePlanParams(p);

        planId = ++_planCount;
        _plans[planId] = Plan({
            merchantId: merchantId.toUint64(),
            token: p.token,
            amount: p.amount,
            introAmount: p.introAmount,
            interval: p.interval,
            trialPeriod: p.trialPeriod,
            introPeriods: p.introPeriods,
            maxSubscribers: p.maxSubscribers,
            activeSubscribers: 0,
            termsVersion: 1,
            status: PlanStatus.Active,
            createdAt: uint64(block.timestamp)
        });
        _merchantPlans[merchantId].push(planId);

        emit PlanCreated(
            planId,
            merchantId,
            p.token,
            p.amount,
            p.interval,
            p.trialPeriod,
            p.introAmount,
            p.introPeriods,
            p.maxSubscribers
        );
    }

    /// @inheritdoc ISubscriptionManager
    /// @dev Allowed on Active and Paused plans (InvalidStatusTransition if Archived). Existing subscriptions keep
    ///      their snapshotted terms.
    function updatePlan(uint256 planId, PlanParams calldata p) external {
        Plan storage plan = _planForOwner(planId);
        if (plan.status == PlanStatus.Archived) revert InvalidStatusTransition();
        if (p.token != plan.token) revert InvalidPlanParams();
        _validatePlanParams(p);
        if (p.maxSubscribers != 0 && p.maxSubscribers < plan.activeSubscribers) revert InvalidPlanParams();

        plan.amount = p.amount;
        plan.introAmount = p.introAmount;
        plan.interval = p.interval;
        plan.trialPeriod = p.trialPeriod;
        plan.introPeriods = p.introPeriods;
        plan.maxSubscribers = p.maxSubscribers;
        uint32 version = plan.termsVersion + 1;
        plan.termsVersion = version;

        emit PlanUpdated(
            planId, version, p.amount, p.interval, p.trialPeriod, p.introAmount, p.introPeriods, p.maxSubscribers
        );
    }

    /// @inheritdoc ISubscriptionManager
    function pausePlan(uint256 planId) external {
        Plan storage plan = _planForOwner(planId);
        if (plan.status != PlanStatus.Active) revert InvalidStatusTransition();
        plan.status = PlanStatus.Paused;
        emit PlanStatusChanged(planId, PlanStatus.Paused);
    }

    /// @inheritdoc ISubscriptionManager
    function resumePlan(uint256 planId) external {
        Plan storage plan = _planForOwner(planId);
        if (plan.status != PlanStatus.Paused) revert InvalidStatusTransition();
        plan.status = PlanStatus.Active;
        emit PlanStatusChanged(planId, PlanStatus.Active);
    }

    /// @inheritdoc ISubscriptionManager
    function archivePlan(uint256 planId) external {
        Plan storage plan = _planForOwner(planId);
        if (plan.status != PlanStatus.Active && plan.status != PlanStatus.Paused) revert InvalidStatusTransition();
        plan.status = PlanStatus.Archived;
        emit PlanStatusChanged(planId, PlanStatus.Archived);
    }

    // ================================================================== merchant: refunds

    /// @inheritdoc ISubscriptionManager
    /// @dev Funds come from msg.sender (the merchant owner), never from this contract. Works while paused and on
    ///      cancelled subscriptions.
    function refund(uint256 subscriptionId, uint128 amount) external nonReentrant {
        Subscription storage s = _subs[subscriptionId];
        if (s.status == SubscriptionStatus.None) revert SubscriptionNotFound();
        if (_merchantOwner(s.merchantId) != msg.sender) revert NotMerchantOwner();
        if (amount == 0) revert ZeroAmount();
        if (amount > s.totalPaid - s.totalRefunded) revert RefundTooLarge();

        // effects
        s.totalRefunded += amount;
        address subscriber = s.subscriber;
        uint256 merchantId = s.merchantId;
        emit Refunded(subscriptionId, merchantId, subscriber, amount);

        // interaction
        IERC20(s.token).safeTransferFrom(msg.sender, subscriber, amount);
    }

    // ================================================================== subscriber

    /// @inheritdoc ISubscriptionManager
    function subscribe(uint256 planId, uint32 expectedTermsVersion, uint128 spendCap, uint64 expiresAt)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 subscriptionId)
    {
        return _subscribe(planId, expectedTermsVersion, spendCap, expiresAt);
    }

    /// @inheritdoc ISubscriptionManager
    /// @dev The permit call is wrapped in try/catch: if someone front-ran the signature (or the token has no
    ///      permit), the allowance check inside the subscribe logic decides.
    function subscribeWithPermit(
        uint256 planId,
        uint32 expectedTermsVersion,
        uint128 spendCap,
        uint64 expiresAt,
        uint256 permitValue,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (uint256 subscriptionId) {
        address token = _plans[planId].token;
        if (token == address(0)) revert PlanNotFound();
        try IERC20Permit(token).permit(msg.sender, address(this), permitValue, permitDeadline, v, r, s) {} catch {}
        return _subscribe(planId, expectedTermsVersion, spendCap, expiresAt);
    }

    /// @inheritdoc ISubscriptionManager
    /// @dev Absolute cap (not additive). Works while paused.
    function updateAuthorization(uint256 subscriptionId, uint128 newRemainingCap, uint64 newExpiresAt) external {
        Subscription storage s = _subs[subscriptionId];
        if (s.status == SubscriptionStatus.None) revert SubscriptionNotFound();
        if (s.subscriber != msg.sender) revert NotSubscriber();
        if (s.status != SubscriptionStatus.Active) revert SubscriptionNotActive();
        if (newExpiresAt != 0 && newExpiresAt <= block.timestamp) revert InvalidAuthorization();

        s.remainingCap = newRemainingCap;
        s.expiresAt = newExpiresAt;
        emit AuthorizationUpdated(subscriptionId, newRemainingCap, newExpiresAt);
    }

    /// @inheritdoc ISubscriptionManager
    /// @dev Works while the contract is paused and while the merchant is paused or suspended.
    function cancelSubscription(uint256 subscriptionId) external {
        Subscription storage s = _subs[subscriptionId];
        if (s.status == SubscriptionStatus.None) revert SubscriptionNotFound();
        if (msg.sender != s.subscriber && msg.sender != _merchantOwner(s.merchantId)) revert NotSubscriber();
        if (s.status != SubscriptionStatus.Active) revert SubscriptionNotActive();
        _cancel(subscriptionId, s);
    }

    /// @inheritdoc ISubscriptionManager
    /// @dev On an already-cancelled subscription it still zeroes the cap and emits AuthorizationRevoked.
    function revokeAuthorization(uint256 subscriptionId) external {
        Subscription storage s = _subs[subscriptionId];
        if (s.status == SubscriptionStatus.None) revert SubscriptionNotFound();
        if (s.subscriber != msg.sender) revert NotSubscriber();

        s.remainingCap = 0;
        emit AuthorizationRevoked(subscriptionId);
        if (s.status == SubscriptionStatus.Active) _cancel(subscriptionId, s);
    }

    // ================================================================== collection

    /// @inheritdoc ISubscriptionManager
    function collectPayment(uint256 subscriptionId) external nonReentrant returns (uint128 amount) {
        CollectionCheck check;
        address payout;
        (check, amount, payout) = _check(subscriptionId, msg.sender);
        if (check != CollectionCheck.Ok) _revertFor(check);

        Subscription storage s = _subs[subscriptionId];
        (uint32 periodIndex, uint64 billedFor) = _applyCharge(s, amount);
        _emitCollected(subscriptionId, s, payout, amount, periodIndex, billedFor);

        IERC20(s.token).safeTransferFrom(s.subscriber, payout, amount);
    }

    /// @inheritdoc ISubscriptionManager
    function collectDuePayments(uint256[] calldata subscriptionIds)
        external
        nonReentrant
        returns (uint256 collectedCount)
    {
        uint256 n = subscriptionIds.length;
        if (n > MAX_BATCH) revert BatchTooLarge();

        for (uint256 i = 0; i < n; ++i) {
            uint256 id = subscriptionIds[i];
            (CollectionCheck check, uint128 amount, address payout) = _check(id, msg.sender);

            if (check != CollectionCheck.Ok) {
                Subscription storage f = _subs[id];
                if (check == CollectionCheck.InsufficientBalance || check == CollectionCheck.InsufficientAllowance) {
                    emit PaymentFailed(id, f.paymentsCount, check, amount, msg.sender);
                } else {
                    emit CollectionSkipped(id, check);
                }
                // A subscription that still cannot pay one full interval after its due date is lapsed: cancel it so
                // it stops holding a plan seat (maxSubscribers). The interval is the grace period for retries and
                // for the subscriber to top up or renew the authorization.
                if (_isLapseReason(check) && block.timestamp >= uint256(f.nextBillingAt) + f.interval) _cancel(id, f);
                continue;
            }

            Subscription storage s = _subs[id];
            // Snapshot for restore if the transfer fails.
            uint128 prevCap = s.remainingCap;
            uint128 prevTotalPaid = s.totalPaid;
            uint64 prevLastPaymentAt = s.lastPaymentAt;
            uint64 prevNext = s.nextBillingAt;

            (uint32 periodIndex, uint64 billedFor) = _applyCharge(s, amount);

            if (IERC20(s.token).trySafeTransferFrom(s.subscriber, payout, amount)) {
                _emitCollected(id, s, payout, amount, periodIndex, billedFor);
                ++collectedCount;
            } else {
                s.remainingCap = prevCap;
                s.totalPaid = prevTotalPaid;
                s.paymentsCount = periodIndex;
                s.lastPaymentAt = prevLastPaymentAt;
                s.nextBillingAt = prevNext;
                emit PaymentFailed(id, periodIndex, CollectionCheck.TransferFailed, amount, msg.sender);
            }
        }
    }

    // ================================================================== views

    /// @notice True once `subscriber` has subscribed to `planId` (trial and intro terms no longer apply to them).
    function hasSubscribed(uint256 planId, address subscriber) external view returns (bool) {
        return _hasSubscribed[planId][subscriber];
    }

    /// @inheritdoc ISubscriptionManager
    function isTokenAllowed(address token) external view returns (bool) {
        return _allowedTokens[token];
    }

    /// @inheritdoc ISubscriptionManager
    function getPlan(uint256 planId) external view returns (Plan memory) {
        if (_plans[planId].status == PlanStatus.None) revert PlanNotFound();
        return _plans[planId];
    }

    /// @inheritdoc ISubscriptionManager
    function getSubscription(uint256 subscriptionId) external view returns (Subscription memory) {
        if (_subs[subscriptionId].status == SubscriptionStatus.None) revert SubscriptionNotFound();
        return _subs[subscriptionId];
    }

    /// @inheritdoc ISubscriptionManager
    function planCount() external view returns (uint256) {
        return _planCount;
    }

    /// @inheritdoc ISubscriptionManager
    function subscriptionCount() external view returns (uint256) {
        return _subCount;
    }

    /// @inheritdoc ISubscriptionManager
    function activeSubscriptionOf(uint256 planId, address subscriber) external view returns (uint256) {
        return _activeSubOf[planId][subscriber];
    }

    /// @inheritdoc ISubscriptionManager
    function getSubscriberSubscriptions(address subscriber, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_subscriberSubs[subscriber], offset, limit);
    }

    /// @inheritdoc ISubscriptionManager
    function getMerchantSubscriptions(uint256 merchantId, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_merchantSubs[merchantId], offset, limit);
    }

    /// @inheritdoc ISubscriptionManager
    function getMerchantPlans(uint256 merchantId, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_merchantPlans[merchantId], offset, limit);
    }

    /// @inheritdoc ISubscriptionManager
    /// @dev Returns 0 for unknown subscriptions.
    function amountDue(uint256 subscriptionId) external view returns (uint128) {
        return _amountDue(_subs[subscriptionId]);
    }

    /// @inheritdoc ISubscriptionManager
    function isDue(uint256 subscriptionId) external view returns (bool) {
        Subscription storage s = _subs[subscriptionId];
        return s.status == SubscriptionStatus.Active && block.timestamp >= s.nextBillingAt;
    }

    /// @inheritdoc ISubscriptionManager
    function previewCollection(uint256 subscriptionId, address caller)
        external
        view
        returns (CollectionCheck check, uint128 amount)
    {
        (check, amount,) = _check(subscriptionId, caller);
    }

    // ================================================================== internal: subscribe

    /// @dev Shared subscribe logic. Caller applies nonReentrant + whenNotPaused.
    function _subscribe(uint256 planId, uint32 expectedTermsVersion, uint128 spendCap, uint64 expiresAt)
        private
        returns (uint256 subscriptionId)
    {
        Plan storage plan = _plans[planId];
        if (plan.status == PlanStatus.None) revert PlanNotFound();
        if (plan.status != PlanStatus.Active) revert PlanNotActive();
        MerchantInfo memory m = _merchantInfo(plan.merchantId);
        if (m.status != IMerchantRegistry.MerchantStatus.Active) revert MerchantNotActive();
        // A payout that cannot pass tokens on (this contract or the token itself) would lock subscriber funds.
        if (m.payout == address(this) || m.payout == plan.token) revert MerchantNotActive();
        if (expectedTermsVersion != plan.termsVersion) revert TermsChanged();
        if (!_allowedTokens[plan.token]) revert TokenNotAllowed();
        if (plan.maxSubscribers != 0 && plan.activeSubscribers >= plan.maxSubscribers) revert PlanFull();
        if (_activeSubOf[planId][msg.sender] != 0) revert AlreadySubscribed();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidAuthorization();

        // Trial and intro pricing apply once per wallet per plan; a returning subscriber pays the full price now.
        uint16 introPeriods = plan.introPeriods;
        bool chargeNow = plan.trialPeriod == 0;
        if (_hasSubscribed[planId][msg.sender]) (introPeriods, chargeNow) = (0, true);
        uint128 firstCharge = introPeriods > 0 ? plan.introAmount : plan.amount;
        if (spendCap < firstCharge) revert InvalidAuthorization();

        address token = plan.token;
        if (chargeNow) {
            if (_balanceOf(token, msg.sender) < firstCharge) revert InsufficientBalance();
            if (_allowance(token, msg.sender) < firstCharge) revert InsufficientAllowance();
        }

        // ---- effects
        subscriptionId = ++_subCount;
        uint64 nowTs = uint64(block.timestamp);
        Subscription storage s = _subs[subscriptionId];
        s.planId = planId.toUint64();
        s.merchantId = plan.merchantId;
        s.subscriber = msg.sender;
        s.token = token;
        s.amount = plan.amount;
        s.introAmount = plan.introAmount;
        s.introPeriods = introPeriods;
        s.interval = plan.interval;
        s.termsVersion = plan.termsVersion;
        s.remainingCap = spendCap;
        s.expiresAt = expiresAt;
        s.createdAt = nowTs;
        s.status = SubscriptionStatus.Active;

        if (chargeNow) {
            s.remainingCap = spendCap - firstCharge;
            s.totalPaid = firstCharge;
            s.paymentsCount = 1;
            s.lastPaymentAt = nowTs;
            s.nextBillingAt = nowTs + plan.interval;
        } else {
            s.nextBillingAt = nowTs + plan.trialPeriod;
        }

        _activeSubOf[planId][msg.sender] = subscriptionId;
        _hasSubscribed[planId][msg.sender] = true;
        _subscriberSubs[msg.sender].push(subscriptionId);
        _merchantSubs[plan.merchantId].push(subscriptionId);
        plan.activeSubscribers += 1;

        _emitSubscribed(subscriptionId, s, spendCap);

        // ---- interaction (first period)
        if (chargeNow) {
            _emitCollected(subscriptionId, s, m.payout, firstCharge, 0, nowTs);
            IERC20(token).safeTransferFrom(msg.sender, m.payout, firstCharge);
        }
    }

    // ================================================================== internal: collection

    /// @dev Single source of truth for whether `caller` may collect `subId` right now. Check order is part of
    ///      the spec: NotFound, NotActive, NotAuthorized, MerchantInactive, ContractPaused, NotDue,
    ///      AuthorizationExpired, SpendCapExceeded, InsufficientBalance, InsufficientAllowance.
    ///      Never reverts for a well-formed registry (token reads are low-level staticcalls).
    /// @return check Ok or the first failing check.
    /// @return amount The amount the next period charges (0 if the subscription does not exist).
    /// @return payout Merchant payout read at call time (only meaningful when check == Ok).
    function _check(uint256 subId, address caller)
        internal
        view
        returns (CollectionCheck check, uint128 amount, address payout)
    {
        Subscription storage s = _subs[subId];
        if (s.status == SubscriptionStatus.None) return (CollectionCheck.NotFound, 0, address(0));
        amount = _amountDue(s);
        if (s.status != SubscriptionStatus.Active) return (CollectionCheck.NotActive, amount, address(0));

        MerchantInfo memory m = _merchantInfo(s.merchantId);
        bool authorized = caller == m.owner || (m.keeperEnabled && hasRole(KEEPER_ROLE, caller));
        if (!authorized) return (CollectionCheck.NotAuthorized, amount, address(0));
        if (m.status != IMerchantRegistry.MerchantStatus.Active) {
            return (CollectionCheck.MerchantInactive, amount, address(0));
        }
        if (m.payout == address(this) || m.payout == s.token) {
            return (CollectionCheck.MerchantInactive, amount, address(0));
        }
        if (paused()) return (CollectionCheck.ContractPaused, amount, address(0));
        if (block.timestamp < s.nextBillingAt) return (CollectionCheck.NotDue, amount, address(0));
        if (s.expiresAt != 0 && block.timestamp >= s.expiresAt) {
            return (CollectionCheck.AuthorizationExpired, amount, address(0));
        }
        if (s.remainingCap < amount) return (CollectionCheck.SpendCapExceeded, amount, address(0));
        if (_balanceOf(s.token, s.subscriber) < amount) {
            return (CollectionCheck.InsufficientBalance, amount, address(0));
        }
        if (_allowance(s.token, s.subscriber) < amount) {
            return (CollectionCheck.InsufficientAllowance, amount, address(0));
        }
        return (CollectionCheck.Ok, amount, m.payout);
    }

    /// @dev Effects of one successful charge. Returns the period index and billedFor for the event.
    ///      No back-billing: if the advanced schedule is still in the past, restart from now.
    function _applyCharge(Subscription storage s, uint128 amount)
        private
        returns (uint32 periodIndex, uint64 billedFor)
    {
        periodIndex = s.paymentsCount;
        billedFor = s.nextBillingAt;

        s.remainingCap -= amount;
        s.totalPaid += amount;
        s.paymentsCount = periodIndex + 1;
        s.lastPaymentAt = uint64(block.timestamp);

        // The next period starts one full interval after this charge, so two charges are never closer than one
        // interval (a late collection does not leave the next one due a second later). No back-billing either.
        s.nextBillingAt = uint64(block.timestamp) + s.interval;
    }

    function _emitSubscribed(uint256 subId, Subscription storage s, uint128 spendCap) private {
        emit Subscribed(
            subId,
            s.planId,
            s.merchantId,
            s.subscriber,
            s.amount,
            s.interval,
            s.termsVersion,
            spendCap,
            s.expiresAt,
            s.nextBillingAt
        );
    }

    function _emitCollected(
        uint256 subId,
        Subscription storage s,
        address payout,
        uint128 amount,
        uint32 periodIndex,
        uint64 billedFor
    ) private {
        emit PaymentCollected(
            subId,
            s.merchantId,
            s.subscriber,
            payout,
            s.token,
            amount,
            periodIndex,
            billedFor,
            s.nextBillingAt,
            msg.sender
        );
    }

    /// @dev Maps a failed CollectionCheck to its typed revert.
    function _revertFor(CollectionCheck check) private pure {
        if (check == CollectionCheck.NotFound) revert SubscriptionNotFound();
        if (check == CollectionCheck.NotActive) revert SubscriptionNotActive();
        if (check == CollectionCheck.NotAuthorized) revert NotAuthorizedCollector();
        if (check == CollectionCheck.MerchantInactive) revert MerchantNotActive();
        if (check == CollectionCheck.ContractPaused) revert EnforcedPause();
        if (check == CollectionCheck.NotDue) revert NotDue();
        if (check == CollectionCheck.AuthorizationExpired) revert AuthorizationExpired();
        if (check == CollectionCheck.SpendCapExceeded) revert SpendCapExceeded();
        if (check == CollectionCheck.InsufficientBalance) revert InsufficientBalance();
        revert InsufficientAllowance();
    }

    // ================================================================== internal: helpers

    function _cancel(uint256 subscriptionId, Subscription storage s) private {
        uint64 nowTs = uint64(block.timestamp);
        s.status = SubscriptionStatus.Cancelled;
        s.cancelledAt = nowTs;
        delete _activeSubOf[s.planId][s.subscriber];
        _plans[s.planId].activeSubscribers -= 1;
        emit SubscriptionCancelled(subscriptionId, msg.sender, nowTs);
    }

    function _isLapseReason(CollectionCheck check) private pure returns (bool) {
        return check == CollectionCheck.InsufficientBalance || check == CollectionCheck.InsufficientAllowance
            || check == CollectionCheck.AuthorizationExpired || check == CollectionCheck.SpendCapExceeded;
    }

    function _amountDue(Subscription storage s) private view returns (uint128) {
        return s.paymentsCount < s.introPeriods ? s.introAmount : s.amount;
    }

    /// @dev Loads a plan and requires msg.sender to be the registry owner of its merchant.
    function _planForOwner(uint256 planId) private view returns (Plan storage plan) {
        plan = _plans[planId];
        if (plan.status == PlanStatus.None) revert PlanNotFound();
        if (_merchantOwner(plan.merchantId) != msg.sender) revert NotPlanMerchant();
    }

    function _validatePlanParams(PlanParams calldata p) private view {
        if (p.amount == 0) revert InvalidPlanParams();
        if (p.interval < MIN_INTERVAL || p.interval > MAX_INTERVAL) revert InvalidPlanParams();
        if (p.trialPeriod > MAX_INTERVAL) revert InvalidPlanParams();
        if (p.introPeriods > 0) {
            if (p.introAmount == 0 || p.introAmount >= p.amount) revert InvalidPlanParams();
        } else if (p.introAmount != 0) {
            revert InvalidPlanParams();
        }
    }

    function _merchantOwner(uint256 merchantId) private view returns (address owner) {
        (owner,,,) = _registry.collectionInfo(merchantId);
    }

    function _merchantInfo(uint256 merchantId) private view returns (MerchantInfo memory m) {
        (m.owner, m.payout, m.status, m.keeperEnabled) = _registry.collectionInfo(merchantId);
    }

    /// @dev balanceOf via staticcall; any failure reads as 0 so a misbehaving token can't revert a batch.
    function _balanceOf(address token, address account) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (account)));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// @dev allowance(account, this) via staticcall; any failure reads as 0.
    function _allowance(address token, address account) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IERC20.allowance, (account, address(this))));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// @dev Returns ids[offset : min(offset+limit, total)]; empty when offset >= total.
    function _page(uint256[] storage list, uint256 offset, uint256 limit)
        private
        view
        returns (uint256[] memory ids, uint256 total)
    {
        total = list.length;
        if (offset >= total || limit == 0) return (new uint256[](0), total);
        uint256 remaining = total - offset;
        uint256 len = limit < remaining ? limit : remaining;
        ids = new uint256[](len);
        for (uint256 i = 0; i < len; ++i) {
            ids[i] = list[offset + i];
        }
    }
}
