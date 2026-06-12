// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";

/// @dev Minimal view of the owning bank's client registry. Declared here (instead of
///      importing CommercialBank) to avoid a circular import: the bank deploys this token
///      in its constructor.
interface IClientRegistry {
    function isClient(address account) external view returns (bool);
}

/// @title DepositToken — tokenized commercial bank deposits (layer M1)
/// @notice Restricted ERC-20 (6 decimals): only registered clients of the owning bank may
///         hold it. Mint/burn/settle are reserved to role holders (the bank for genesis
///         credit, the SettlementEngine for payments). Pausable by the bank (freeze).
/// @dev INVARIANT 5: only registered clients ever hold a non-zero balance. Enforced
///      unconditionally in `_update` — no engine bypass needed, every legal engine
///      operation targets registered clients by construction.
contract DepositToken is ERC20, ERC20Pausable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice The CommercialBank owning this token; queried for client registration.
    IClientRegistry public immutable bank;

    error NotClient(address account);

    /// @param name_ Token name (e.g. "Bank A Deposit").
    /// @param symbol_ Token symbol (e.g. "DEP-A").
    /// @param bank_ The owning CommercialBank: sole admin, pauser and genesis minter;
    ///              grants engine roles via its `setSettlementEngine`.
    constructor(string memory name_, string memory symbol_, address bank_) ERC20(name_, symbol_) {
        bank = IClientRegistry(bank_);
        _grantRole(DEFAULT_ADMIN_ROLE, bank_);
        _grantRole(PAUSER_ROLE, bank_);
        _grantRole(MINTER_ROLE, bank_);
    }

    /// @notice All tokens of the system use 6 decimals (USDC style).
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Creates deposits for a registered client (settlement inflow or bank credit).
    /// @param to The receiving client (must be registered with the owning bank).
    /// @param amount Amount in 6-decimals units.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Destroys deposits held by a client (settlement outflow).
    /// @param from The client whose balance is burned.
    /// @param amount Amount in 6-decimals units.
    function burn(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(from, amount);
    }

    /// @notice Moves deposits between two registered clients without allowance.
    ///         Intrabank settlement path used by the SettlementEngine: a payment between
    ///         clients of the same bank is a book transfer, total supply never moves.
    /// @param from The paying client.
    /// @param to The receiving client.
    /// @param amount Amount in 6-decimals units.
    function settle(address from, address to, uint256 amount) external onlyRole(SETTLER_ROLE) {
        _transfer(from, to, amount);
    }

    /// @notice Freezes all token movement (bank freeze, e.g. SVB-style suspension).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes token movement (freeze resolution).
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @dev Holder restriction: mints require a registered client recipient; transfers
    ///      (including `settle`) require both ends registered; burns are unrestricted
    ///      (gated by BURNER_ROLE, and the engine only burns from verified clients).
    ///      ERC20Pausable's `_update` then blocks EVERY path while frozen — including
    ///      engine mint/burn/settle, which is the depeg-scenario trigger (V2).
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable) {
        if (from == address(0)) {
            if (!bank.isClient(to)) revert NotClient(to);
        } else if (to != address(0)) {
            if (!bank.isClient(from)) revert NotClient(from);
            if (!bank.isClient(to)) revert NotClient(to);
        }
        super._update(from, to, value);
    }
}
