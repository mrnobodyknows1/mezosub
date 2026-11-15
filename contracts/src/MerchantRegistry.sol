// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";

/// @title MerchantRegistry
/// @notice Wallet-owned merchant identities for MezoSub. One merchant per owner wallet, ids start at 1.
/// @dev The admin (DEFAULT_ADMIN_ROLE) can only suspend / unsuspend a merchant. It cannot change a payout,
///      an owner or any metadata, and this contract never touches tokens.
contract MerchantRegistry is IMerchantRegistry, AccessControl {
    /// @dev merchantId => Merchant. Id 0 is never used.
    mapping(uint256 => Merchant) private _merchants;
    /// @dev owner wallet => merchantId (0 = none).
    mapping(address => uint256) private _merchantIdOf;
    /// @dev Number of merchants ever registered (== highest id).
    uint256 private _merchantCount;

    /// @param admin Receives DEFAULT_ADMIN_ROLE (suspend / unsuspend). Usually the deployer.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ modifiers

    /// @dev Reverts MerchantNotFound for unknown ids and NotMerchantOwner if msg.sender is not the owner.
    modifier onlyMerchantOwner(uint256 merchantId) {
        if (_merchants[merchantId].status == MerchantStatus.None) revert MerchantNotFound();
        if (_merchants[merchantId].owner != msg.sender) revert NotMerchantOwner();
        _;
    }

    /// @dev Reverts MerchantNotFound for unknown ids.
    modifier exists(uint256 merchantId) {
        if (_merchants[merchantId].status == MerchantStatus.None) revert MerchantNotFound();
        _;
    }

    // ------------------------------------------------------------------ owner actions

    /// @inheritdoc IMerchantRegistry
    function registerMerchant(address payout, string calldata metadataURI) external returns (uint256 merchantId) {
        if (payout == address(0)) revert ZeroAddress();
        if (_merchantIdOf[msg.sender] != 0) revert AlreadyRegistered();

        merchantId = ++_merchantCount;
        _merchants[merchantId] = Merchant({
            owner: msg.sender,
            payout: payout,
            status: MerchantStatus.Active,
            keeperEnabled: true,
            createdAt: uint64(block.timestamp),
            metadataURI: metadataURI
        });
        _merchantIdOf[msg.sender] = merchantId;

        emit MerchantRegistered(merchantId, msg.sender, payout, metadataURI);
    }

    /// @inheritdoc IMerchantRegistry
    /// @dev Applies to every future collection (payout is read at collection time).
    function setPayout(uint256 merchantId, address payout) external onlyMerchantOwner(merchantId) {
        if (payout == address(0)) revert ZeroAddress();
        _merchants[merchantId].payout = payout;
        emit MerchantPayoutChanged(merchantId, payout);
    }

    /// @inheritdoc IMerchantRegistry
    function setMetadataURI(uint256 merchantId, string calldata metadataURI) external onlyMerchantOwner(merchantId) {
        _merchants[merchantId].metadataURI = metadataURI;
        emit MerchantMetadataChanged(merchantId, metadataURI);
    }

    /// @inheritdoc IMerchantRegistry
    function setKeeperEnabled(uint256 merchantId, bool enabled) external onlyMerchantOwner(merchantId) {
        _merchants[merchantId].keeperEnabled = enabled;
        emit MerchantKeeperAccessChanged(merchantId, enabled);
    }

    /// @inheritdoc IMerchantRegistry
    function pauseMerchant(uint256 merchantId) external onlyMerchantOwner(merchantId) {
        _transition(merchantId, MerchantStatus.Active, MerchantStatus.Paused);
    }

    /// @inheritdoc IMerchantRegistry
    function resumeMerchant(uint256 merchantId) external onlyMerchantOwner(merchantId) {
        _transition(merchantId, MerchantStatus.Paused, MerchantStatus.Active);
    }

    /// @inheritdoc IMerchantRegistry
    function transferMerchantOwnership(uint256 merchantId, address newOwner) external onlyMerchantOwner(merchantId) {
        if (newOwner == address(0)) revert ZeroAddress();
        // A suspended merchant stays with its owner: transferring it would free the owner to register a new one.
        if (_merchants[merchantId].status == MerchantStatus.Suspended) revert InvalidStatusTransition();
        if (_merchantIdOf[newOwner] != 0) revert AlreadyRegistered();

        address previousOwner = msg.sender;
        _merchants[merchantId].owner = newOwner;
        delete _merchantIdOf[previousOwner];
        _merchantIdOf[newOwner] = merchantId;

        emit MerchantOwnershipTransferred(merchantId, previousOwner, newOwner);
    }

    // ------------------------------------------------------------------ admin actions

    /// @inheritdoc IMerchantRegistry
    function suspendMerchant(uint256 merchantId) external onlyRole(DEFAULT_ADMIN_ROLE) exists(merchantId) {
        MerchantStatus current = _merchants[merchantId].status;
        if (current != MerchantStatus.Active && current != MerchantStatus.Paused) revert InvalidStatusTransition();
        _merchants[merchantId].status = MerchantStatus.Suspended;
        emit MerchantStatusChanged(merchantId, MerchantStatus.Suspended);
    }

    /// @inheritdoc IMerchantRegistry
    function unsuspendMerchant(uint256 merchantId) external onlyRole(DEFAULT_ADMIN_ROLE) exists(merchantId) {
        _transition(merchantId, MerchantStatus.Suspended, MerchantStatus.Active);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IMerchantRegistry
    /// @dev Reverts MerchantNotFound for unknown ids (including 0).
    function getMerchant(uint256 merchantId) external view exists(merchantId) returns (Merchant memory) {
        return _merchants[merchantId];
    }

    /// @inheritdoc IMerchantRegistry
    function merchantIdOf(address owner) external view returns (uint256) {
        return _merchantIdOf[owner];
    }

    /// @inheritdoc IMerchantRegistry
    function merchantCount() external view returns (uint256) {
        return _merchantCount;
    }

    /// @inheritdoc IMerchantRegistry
    function isActive(uint256 merchantId) external view returns (bool) {
        return _merchants[merchantId].status == MerchantStatus.Active;
    }

    /// @notice Gas-light read used by SubscriptionManager on every collection (skips copying metadataURI).
    /// @dev Not part of the frozen interface; returns zero values for unknown ids.
    function collectionInfo(uint256 merchantId)
        external
        view
        returns (address owner, address payout, MerchantStatus status, bool keeperEnabled)
    {
        Merchant storage m = _merchants[merchantId];
        return (m.owner, m.payout, m.status, m.keeperEnabled);
    }

    // ------------------------------------------------------------------ internal

    function _transition(uint256 merchantId, MerchantStatus from, MerchantStatus to) private {
        if (_merchants[merchantId].status != from) revert InvalidStatusTransition();
        _merchants[merchantId].status = to;
        emit MerchantStatusChanged(merchantId, to);
    }
}
