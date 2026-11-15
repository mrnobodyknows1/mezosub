// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ISubscriptionManager — FROZEN interface.
/// @notice Non-custodial recurring MUSD billing. The contract never holds funds: every collection is a
///         single `transferFrom(subscriber -> merchant.payout)`. A subscription snapshots the plan's terms
///         at subscribe time; later plan edits only affect NEW subscribers.
///
/// Authorization model (two layers, both must allow a charge):
///   1. ERC-20 allowance subscriber -> this contract (shared across the subscriber's subscriptions).
///   2. Per-subscription authorization: `remainingCap` (total MUSD this subscription may still pull) and
///      optional `expiresAt`. Only the subscriber can change it.
///
/// Who can collect: the merchant owner, or an account with KEEPER_ROLE when the merchant has
/// `keeperEnabled`. Nobody can choose the recipient (always merchant.payout) or the amount (always the
/// snapshotted period amount).
interface ISubscriptionManager {
    enum PlanStatus {
        None,
        Active, // accepting new subscribers
        Paused, // no new subscribers; existing subscriptions keep billing
        Archived // terminal; no new subscribers; existing subscriptions keep billing
    }

    /// Stored status only. Trialing / due / expired / cap-exhausted / past-due are derived off-chain
    /// from the stored fields (see docs/CONTRACTS.md).
    enum SubscriptionStatus {
        None,
        Active,
        Cancelled // terminal
    }

    /// Reason codes for previewCollection, CollectionSkipped and PaymentFailed.
    enum CollectionCheck {
        Ok,
        NotFound,
        NotActive, // cancelled
        NotAuthorized, // caller is neither merchant owner nor an enabled keeper
        MerchantInactive, // merchant Paused or Suspended
        ContractPaused,
        NotDue, // block.timestamp < nextBillingAt
        AuthorizationExpired, // expiresAt != 0 && block.timestamp >= expiresAt
        SpendCapExceeded, // remainingCap < amountDue
        InsufficientBalance,
        InsufficientAllowance,
        TransferFailed
    }

    struct PlanParams {
        address token; // must be allowlisted (MUSD)
        uint128 amount; // per period, token units (18 dec for MUSD), > 0
        uint32 interval; // seconds, >= MIN_INTERVAL, <= MAX_INTERVAL
        uint32 trialPeriod; // seconds, 0 = none; <= MAX_INTERVAL
        uint128 introAmount; // price for the first `introPeriods` charges; 0 < introAmount < amount if introPeriods > 0
        uint16 introPeriods; // 0 = no intro pricing
        uint32 maxSubscribers; // 0 = unlimited (counts ACTIVE subscriptions)
    }

    struct Plan {
        uint64 merchantId;
        address token;
        uint128 amount;
        uint128 introAmount;
        uint32 interval;
        uint32 trialPeriod;
        uint16 introPeriods;
        uint32 maxSubscribers;
        uint32 activeSubscribers;
        uint32 termsVersion; // starts at 1, +1 on every updatePlan
        PlanStatus status;
        uint64 createdAt;
    }

    struct Subscription {
        uint64 planId;
        uint64 merchantId;
        address subscriber;
        address token;
        // ---- terms snapshot (never changed by the merchant) ----
        uint128 amount;
        uint128 introAmount;
        uint16 introPeriods;
        uint32 interval;
        uint32 termsVersion;
        // ---- authorization (only the subscriber changes it) ----
        uint128 remainingCap;
        uint64 expiresAt; // 0 = no expiry
        // ---- billing state ----
        uint64 nextBillingAt; // earliest timestamp the next period may be charged
        uint64 createdAt;
        uint64 lastPaymentAt; // 0 = never
        uint64 cancelledAt; // 0 = not cancelled
        uint32 paymentsCount; // successful charges == index of the next billing period
        uint128 totalPaid;
        uint128 totalRefunded;
        SubscriptionStatus status;
    }

    // ---------------------------------------------------------------- events
    event TokenAllowed(address indexed token, bool allowed);
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
    event PlanUpdated(
        uint256 indexed planId,
        uint32 termsVersion,
        uint128 amount,
        uint32 interval,
        uint32 trialPeriod,
        uint128 introAmount,
        uint16 introPeriods,
        uint32 maxSubscribers
    );
    event PlanStatusChanged(uint256 indexed planId, PlanStatus status);
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
    /// periodIndex = paymentsCount before this charge (0 = first period). billedFor = nextBillingAt before
    /// this charge (for the first charge in subscribe(), the subscribe timestamp).
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
    /// Emitted only by collectDuePayments for funding failures (InsufficientBalance / InsufficientAllowance /
    /// TransferFailed). No state changes accompany it.
    event PaymentFailed(
        uint256 indexed subscriptionId, uint32 periodIndex, CollectionCheck reason, uint128 amount, address collector
    );
    /// Emitted only by collectDuePayments for structural skips (not due, cancelled, unauthorized, ...).
    event CollectionSkipped(uint256 indexed subscriptionId, CollectionCheck reason);
    event SubscriptionCancelled(uint256 indexed subscriptionId, address indexed cancelledBy, uint64 cancelledAt);
    event AuthorizationUpdated(uint256 indexed subscriptionId, uint128 remainingCap, uint64 expiresAt);
    event AuthorizationRevoked(uint256 indexed subscriptionId);
    event Refunded(uint256 indexed subscriptionId, uint256 indexed merchantId, address indexed subscriber, uint128 amount);

    // ---------------------------------------------------------------- errors
    error TokenNotAllowed();
    error InvalidPlanParams();
    error PlanNotFound();
    error PlanNotActive();
    error PlanFull();
    error TermsChanged(); // expectedTermsVersion != plan.termsVersion (front-running guard)
    error NotPlanMerchant();
    error MerchantNotActive();
    error NotMerchantOwner();
    error AlreadySubscribed(); // one ACTIVE subscription per (plan, subscriber)
    error InvalidAuthorization(); // spendCap too small for the first charge, or expiresAt in the past
    error SubscriptionNotFound();
    error SubscriptionNotActive();
    error NotSubscriber();
    error NotAuthorizedCollector();
    error NotDue();
    error AuthorizationExpired();
    error SpendCapExceeded();
    error InsufficientBalance();
    error InsufficientAllowance();
    error BatchTooLarge();
    error RefundTooLarge();
    error ZeroAmount();
    error InvalidStatusTransition();

    // ---------------------------------------------------------------- admin (DEFAULT_ADMIN_ROLE)
    // Admin can: allowlist tokens, pause/unpause, grant/revoke KEEPER_ROLE. Admin can NOT move funds,
    // change subscription terms or redirect payouts.
    function setTokenAllowed(address token, bool allowed) external;
    function pause() external; // blocks subscribe + collect; cancel/revoke/updateAuthorization/refund still work
    function unpause() external;

    // ---------------------------------------------------------------- merchant (merchant owner)
    function createPlan(PlanParams calldata p) external returns (uint256 planId); // merchant must be Active
    /// Changes terms for FUTURE subscribers only; token cannot change; bumps termsVersion.
    function updatePlan(uint256 planId, PlanParams calldata p) external;
    function pausePlan(uint256 planId) external; // Active -> Paused
    function resumePlan(uint256 planId) external; // Paused -> Active
    function archivePlan(uint256 planId) external; // Active|Paused -> Archived
    /// Explicit merchant-initiated refund paid FROM msg.sender's wallet (needs allowance) to the subscriber.
    /// amount <= totalPaid - totalRefunded. Works on cancelled subscriptions too.
    function refund(uint256 subscriptionId, uint128 amount) external;

    // ---------------------------------------------------------------- subscriber
    /// Starts a subscription with snapshotted terms. If plan.trialPeriod == 0 the first period is charged
    /// immediately (counts against spendCap) and nextBillingAt = now + interval; otherwise nothing is charged
    /// and nextBillingAt = now + trialPeriod. Requires an ERC-20 allowance >= first charge.
    function subscribe(uint256 planId, uint32 expectedTermsVersion, uint128 spendCap, uint64 expiresAt)
        external
        returns (uint256 subscriptionId);
    /// Same, after an EIP-2612 permit(subscriber -> this, permitValue). Permit failure is tolerated if the
    /// allowance is already sufficient (front-run safe).
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
    ) external returns (uint256 subscriptionId);
    /// Subscriber sets a new absolute remainingCap and expiry (renew / restore authorization).
    function updateAuthorization(uint256 subscriptionId, uint128 newRemainingCap, uint64 newExpiresAt) external;
    /// Subscriber or merchant owner. Terminal. Allowed while paused.
    function cancelSubscription(uint256 subscriptionId) external;
    /// Subscriber only: zeroes remainingCap and cancels (if still active). Emits AuthorizationRevoked.
    /// (Revoking the ERC-20 allowance itself is a separate token.approve(manager, 0) by the subscriber.)
    function revokeAuthorization(uint256 subscriptionId) external;

    // ---------------------------------------------------------------- collection
    /// Charges exactly one due period. Reverts with a typed error on any failed check (state unchanged).
    function collectPayment(uint256 subscriptionId) external returns (uint128 amount);
    /// Best-effort batch (length <= MAX_BATCH). Never reverts for per-item problems: structural problems emit
    /// CollectionSkipped, funding problems emit PaymentFailed; neither changes state.
    function collectDuePayments(uint256[] calldata subscriptionIds) external returns (uint256 collectedCount);

    // ---------------------------------------------------------------- views
    function registry() external view returns (address);
    function MIN_INTERVAL() external view returns (uint32); // immutable, set at deploy (testnet: 300s)
    function MAX_INTERVAL() external view returns (uint32); // 366 days
    function MAX_BATCH() external view returns (uint256); // 50
    function KEEPER_ROLE() external view returns (bytes32);
    function isTokenAllowed(address token) external view returns (bool);

    function getPlan(uint256 planId) external view returns (Plan memory);
    function getSubscription(uint256 subscriptionId) external view returns (Subscription memory);
    function planCount() external view returns (uint256);
    function subscriptionCount() external view returns (uint256);
    function activeSubscriptionOf(uint256 planId, address subscriber) external view returns (uint256); // 0 = none

    /// Paginated id lists (no unbounded iteration). Returns ids[offset : offset+limit].
    function getSubscriberSubscriptions(address subscriber, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total);
    function getMerchantSubscriptions(uint256 merchantId, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total);
    function getMerchantPlans(uint256 merchantId, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total);

    /// Amount the next period will charge (intro price while paymentsCount < introPeriods).
    function amountDue(uint256 subscriptionId) external view returns (uint128);
    /// Active && block.timestamp >= nextBillingAt (ignores funding/authorization).
    function isDue(uint256 subscriptionId) external view returns (bool);
    /// Full dry-run of collectPayment for `caller` at the current block: returns Ok or the first failing check.
    function previewCollection(uint256 subscriptionId, address caller)
        external
        view
        returns (CollectionCheck check, uint128 amount);
}
