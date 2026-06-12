// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {WCBDC} from "./WCBDC.sol";

/// @title CentralBank — issuer and administrator of the wCBDC (layer M0)
/// @notice Owns all wCBDC admin powers: bank allowlist, M0 issuance (genesis only in V1)
///         and the regulatory reserve ratio parameter. The operator EOA decides, this
///         contract enforces, the token accounts.
contract CentralBank is AccessControl {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice The wCBDC token, deployed and solely administered by this contract.
    WCBDC public immutable wcbdc;

    /// @notice Regulatory reserve ratio threshold in basis points (1_000 = 10%).
    /// @dev Soft constraint only: read by CommercialBank.checkReserveRatio to emit
    ///      ReserveRatioBreached. It never blocks settlement (trap #4) — only
    ///      insufficient wCBDC does.
    uint256 public reserveRatioThresholdBps;

    /// @notice The SettlementEngine currently holding SETTLER_ROLE on the wCBDC.
    address public settlementEngine;

    event BankRegistered(address indexed bank);
    event BankRemoved(address indexed bank);
    event CBDCMinted(address indexed bank, uint256 amount);
    event CBDCBurned(address indexed bank, uint256 amount);
    event ReserveRatioThresholdUpdated(uint256 previousBps, uint256 newBps);
    event SettlementEngineUpdated(address indexed previousEngine, address indexed newEngine);

    error ThresholdAboveMax(uint256 bps);

    /// @param operator The central bank operator EOA (deployer, HD index 0).
    constructor(address operator) {
        _grantRole(DEFAULT_ADMIN_ROLE, operator);
        _grantRole(OPERATOR_ROLE, operator);
        // Atomic wiring: the token is born with this contract as its only admin —
        // no configuration window where someone else holds wCBDC powers.
        wcbdc = new WCBDC(address(this));
        reserveRatioThresholdBps = 1_000;
        emit ReserveRatioThresholdUpdated(0, 1_000);
    }

    /// @notice Registers a commercial bank as an allowed wCBDC holder.
    /// @param bank The CommercialBank contract address.
    function registerBank(address bank) external onlyRole(OPERATOR_ROLE) {
        wcbdc.setAllowlisted(bank, true);
        emit BankRegistered(bank);
    }

    /// @notice Removes a commercial bank from the wCBDC allowlist.
    /// @param bank The CommercialBank contract address.
    function removeBank(address bank) external onlyRole(OPERATOR_ROLE) {
        wcbdc.setAllowlisted(bank, false);
        emit BankRemoved(bank);
    }

    /// @notice True if `bank` is currently an allowed wCBDC holder.
    /// @param bank The address to check.
    function isRegisteredBank(address bank) external view returns (bool) {
        return wcbdc.isAllowlisted(bank);
    }

    /// @notice Issues central bank money to a registered bank (genesis only in V1).
    /// @param bank The receiving bank (must be registered).
    /// @param amount Amount in 6-decimals units.
    function mintCBDC(address bank, uint256 amount) external onlyRole(OPERATOR_ROLE) {
        wcbdc.mint(bank, amount);
        emit CBDCMinted(bank, amount);
    }

    /// @notice Destroys central bank money held by a bank.
    /// @param bank The bank whose reserves are burned.
    /// @param amount Amount in 6-decimals units.
    function burnCBDC(address bank, uint256 amount) external onlyRole(OPERATOR_ROLE) {
        wcbdc.burn(bank, amount);
        emit CBDCBurned(bank, amount);
    }

    /// @notice Plugs a SettlementEngine into the wCBDC: grants it SETTLER_ROLE (the
    ///         power to move reserves between banks), revoking the previous engine's.
    /// @param engine The engine address (address(0) to unplug).
    function setSettlementEngine(address engine) external onlyRole(OPERATOR_ROLE) {
        address previous = settlementEngine;
        if (previous != address(0)) {
            wcbdc.revokeRole(wcbdc.SETTLER_ROLE(), previous);
        }
        if (engine != address(0)) {
            wcbdc.grantRole(wcbdc.SETTLER_ROLE(), engine);
        }
        settlementEngine = engine;
        emit SettlementEngineUpdated(previous, engine);
    }

    /// @notice Updates the regulatory reserve ratio threshold.
    /// @param newThresholdBps New threshold in basis points (max 10_000 = 100%).
    function setReserveRatioThreshold(uint256 newThresholdBps) external onlyRole(OPERATOR_ROLE) {
        if (newThresholdBps > BPS_DENOMINATOR) revert ThresholdAboveMax(newThresholdBps);
        emit ReserveRatioThresholdUpdated(reserveRatioThresholdBps, newThresholdBps);
        reserveRatioThresholdBps = newThresholdBps;
    }
}
