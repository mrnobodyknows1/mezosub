// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Token whose transferFrom can be switched to return false (no revert, no state change) or to revert.
///         balanceOf / allowance stay truthful, so every pre-check passes and only the transfer itself fails.
contract FalseReturnToken is ERC20 {
    bool public returnFalse;
    bool public revertOnTransfer;

    constructor() ERC20("False USD", "FUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setReturnFalse(bool v) external {
        returnFalse = v;
    }

    function setRevertOnTransfer(bool v) external {
        revertOnTransfer = v;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (revertOnTransfer) revert("nope");
        if (returnFalse) return false;
        return super.transferFrom(from, to, value);
    }
}
