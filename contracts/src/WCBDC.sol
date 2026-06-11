// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title WCBDC — Wholesale Central Bank Digital Currency (layer M0)
/// @notice Restricted ERC-20: only allowlisted commercial bank contracts may hold it.
///         Mint/burn are reserved to the CentralBank contract (sole admin); SETTLER_ROLE
///         lets the SettlementEngine move reserves between banks without allowance.
/// @dev INVARIANT 4: only allowlisted addresses ever hold a non-zero balance. Enforced
///      in `_update` on every mint and transfer path.
contract WCBDC is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    /// @notice True for addresses allowed to hold wCBDC (the CommercialBank contracts).
    mapping(address account => bool) public isAllowlisted;

    event AllowlistUpdated(address indexed account, bool allowed);

    error NotAllowlisted(address account);

    /// @param admin The CentralBank contract: sole allowlist admin, minter and burner.
    constructor(address admin) ERC20("Wholesale CBDC", "wCBDC") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(BURNER_ROLE, admin);
    }

    /// @notice All tokens of the system use 6 decimals (USDC style).
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Adds or removes an account from the holder allowlist.
    /// @param account The account whose allowlist status changes.
    /// @param allowed True to allow holding wCBDC, false to revoke.
    function setAllowlisted(address account, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isAllowlisted[account] = allowed;
        emit AllowlistUpdated(account, allowed);
    }

    /// @notice Creates new central bank money for an allowlisted bank.
    /// @param to The receiving bank (must be allowlisted).
    /// @param amount Amount in 6-decimals units.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Destroys central bank money held by a bank.
    /// @dev Burning is allowed even if `from` was removed from the allowlist, so the
    ///      central bank can always wind down a removed bank's stranded reserves.
    /// @param from The bank whose balance is burned.
    /// @param amount Amount in 6-decimals units.
    function burn(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(from, amount);
    }

    /// @notice Moves reserves between two allowlisted banks without allowance.
    ///         Settlement path used by the SettlementEngine (role granted in Phase 2).
    /// @param from The paying bank.
    /// @param to The receiving bank.
    /// @param amount Amount in 6-decimals units.
    function settle(address from, address to, uint256 amount) external onlyRole(SETTLER_ROLE) {
        _transfer(from, to, amount);
    }

    /// @dev Holder restriction: mints require an allowlisted recipient; transfers require
    ///      both ends allowlisted; burns are unrestricted (see `burn`). Covers every path
    ///      (transfer, transferFrom, settle, mint).
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0)) {
            if (!isAllowlisted[to]) revert NotAllowlisted(to);
        } else if (to != address(0)) {
            if (!isAllowlisted[from]) revert NotAllowlisted(from);
            if (!isAllowlisted[to]) revert NotAllowlisted(to);
        }
        super._update(from, to, value);
    }
}
