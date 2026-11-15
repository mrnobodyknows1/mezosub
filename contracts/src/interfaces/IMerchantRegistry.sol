// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IMerchantRegistry — FROZEN interface.
/// @notice Wallet-owned merchant identities. Only an opaque metadata URI lives on-chain; names,
///         logos and contact details stay off-chain (Postgres).
interface IMerchantRegistry {
    /// Active: can create plans, take new subscribers and collect.
    /// Paused: set by the merchant owner. No new subscribers, no collections. Cancels still work.
    /// Suspended: set by the admin (abuse response). Same effect as Paused; only admin can lift it.
    enum MerchantStatus {
        None,
        Active,
        Paused,
        Suspended
    }

    struct Merchant {
        address owner; // wallet that controls the merchant
        address payout; // where collected MUSD is sent (owner can change; keeper cannot)
        MerchantStatus status;
        bool keeperEnabled; // merchant opt-in: KEEPER_ROLE may trigger collections for this merchant
        uint64 createdAt;
        string metadataURI; // opaque pointer, e.g. "mezosub:merchant:<uuid>"
    }

    event MerchantRegistered(uint256 indexed merchantId, address indexed owner, address payout, string metadataURI);
    event MerchantPayoutChanged(uint256 indexed merchantId, address payout);
    event MerchantMetadataChanged(uint256 indexed merchantId, string metadataURI);
    event MerchantStatusChanged(uint256 indexed merchantId, MerchantStatus status);
    event MerchantKeeperAccessChanged(uint256 indexed merchantId, bool enabled);
    event MerchantOwnershipTransferred(uint256 indexed merchantId, address indexed previousOwner, address indexed newOwner);

    error NotMerchantOwner();
    error MerchantNotFound();
    error AlreadyRegistered();
    error ZeroAddress();
    error InvalidStatusTransition();

    /// One merchant per owner wallet. Starts Active. keeperEnabled defaults to true.
    function registerMerchant(address payout, string calldata metadataURI) external returns (uint256 merchantId);
    function setPayout(uint256 merchantId, address payout) external; // owner
    function setMetadataURI(uint256 merchantId, string calldata metadataURI) external; // owner
    function setKeeperEnabled(uint256 merchantId, bool enabled) external; // owner
    function pauseMerchant(uint256 merchantId) external; // owner: Active -> Paused
    function resumeMerchant(uint256 merchantId) external; // owner: Paused -> Active
    function suspendMerchant(uint256 merchantId) external; // admin: Active|Paused -> Suspended
    function unsuspendMerchant(uint256 merchantId) external; // admin: Suspended -> Active
    function transferMerchantOwnership(uint256 merchantId, address newOwner) external; // owner; newOwner must not own one

    function getMerchant(uint256 merchantId) external view returns (Merchant memory);
    function merchantIdOf(address owner) external view returns (uint256); // 0 = none
    function merchantCount() external view returns (uint256);
    function isActive(uint256 merchantId) external view returns (bool);
}
