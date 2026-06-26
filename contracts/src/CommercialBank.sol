// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {CentralBank} from "./CentralBank.sol";
import {DepositToken} from "./DepositToken.sol";
import {WCBDC} from "./WCBDC.sol";

/// @title CommercialBank — commercial bank holding wCBDC reserves and issuing deposits
/// @notice Holds the bank's central bank money (reserves == wCBDC.balanceOf(this)), keeps
///         the client registry gating its DepositToken, and can freeze/unfreeze it. The
///         operator EOA decides, this contract enforces, the tokens account.
contract CommercialBank is AccessControl {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Least-privilege role for the public-demo faucet (Option B): may ONLY onboard
    ///         visitors (register + capped credit), never freeze or rewire. Granted by the
    ///         bank operator to the relayer's own EOA, so the relayer keeps a single key.
    bytes32 public constant FAUCET_ROLE = keccak256("FAUCET_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Per-onboard ceiling on faucet-credited test deposits — an on-chain cap so a
    ///         FAUCET_ROLE holder can never mint unbounded M1.
    uint256 public constant MAX_FAUCET_CREDIT = 1_000_000e6;

    /// @notice The central bank, read for the regulatory reserve ratio threshold.
    CentralBank public immutable centralBank;

    /// @notice The wCBDC token; this contract's balance of it IS the bank's reserves.
    WCBDC public immutable wcbdc;

    /// @notice The bank's deposit token, deployed and solely administered by this contract.
    DepositToken public immutable depositToken;

    /// @notice The SettlementEngine currently holding mint/burn/settle roles on the token.
    address public settlementEngine;

    /// @notice True for accounts registered as clients of this bank.
    mapping(address account => bool) public isClient;

    event ClientRegistered(address indexed client);
    event ClientRemoved(address indexed client);
    event ClientCredited(address indexed client, uint256 amount);
    event BankFrozen();
    event BankUnfrozen();
    event SettlementEngineUpdated(address indexed previousEngine, address indexed newEngine);
    event ReserveRatioBreached(address indexed bank, uint256 ratioBps, uint256 thresholdBps);

    error AlreadyClient(address account);
    error NotClient(address account);
    error ClientHasBalance(address client, uint256 balance);
    error FaucetAmountTooHigh(uint256 amount, uint256 max);

    /// @param operator The bank operator EOA.
    /// @param centralBank_ The CentralBank contract (source of wCBDC and ratio threshold).
    /// @param depositName Deposit token name (e.g. "Bank A Deposit").
    /// @param depositSymbol Deposit token symbol (e.g. "DEP-A").
    constructor(address operator, CentralBank centralBank_, string memory depositName, string memory depositSymbol) {
        _grantRole(DEFAULT_ADMIN_ROLE, operator);
        _grantRole(OPERATOR_ROLE, operator);
        centralBank = centralBank_;
        wcbdc = centralBank_.wcbdc();
        // Atomic wiring (same pattern as CentralBank -> WCBDC): the token is born with
        // this contract as its only admin.
        depositToken = new DepositToken(depositName, depositSymbol, address(this));
    }

    /*//////////////////////////////////////////////////////////////
                            CLIENT REGISTRY
    //////////////////////////////////////////////////////////////*/

    /// @notice Registers an account as a client of this bank (EOA or contract — StableCo
    ///         becomes a client of Bank A in Phase 4).
    /// @param client The account to register.
    function registerClient(address client) external onlyRole(OPERATOR_ROLE) {
        if (isClient[client]) revert AlreadyClient(client);
        isClient[client] = true;
        emit ClientRegistered(client);
    }

    /// @notice Removes a client from the registry.
    /// @dev Reverts while the client still holds deposits: a removed client could neither
    ///      transfer nor be settled out, stranding a balance and breaking INVARIANT 5
    ///      (only registered clients hold the bank's deposits).
    /// @param client The account to remove.
    function removeClient(address client) external onlyRole(OPERATOR_ROLE) {
        if (!isClient[client]) revert NotClient(client);
        uint256 balance = depositToken.balanceOf(client);
        if (balance > 0) revert ClientHasBalance(client, balance);
        isClient[client] = false;
        emit ClientRemoved(client);
    }

    /// @notice Credits deposits to a registered client. Genesis seeding path in V1, and
    ///         the future "loans make deposits" credit-creation hook (V3).
    /// @dev Deliberately unlimited operator minting power — realistic, and the reason why
    ///      aggregate M1 is NOT a system invariant. Degrades the reserve ratio, so the
    ///      soft regulatory check runs afterwards (same rule as settlements, trap #4).
    /// @param client The receiving client (must be registered; enforced by the token hook).
    /// @param amount Amount in 6-decimals units.
    function creditClient(address client, uint256 amount) external onlyRole(OPERATOR_ROLE) {
        depositToken.mint(client, amount);
        emit ClientCredited(client, amount);
        checkReserveRatio();
    }

    /// @notice Public-demo onboarding (Option B): registers a visitor and credits capped
    ///         test deposits in one call. Held by the relayer (FAUCET_ROLE) — a least-
    ///         privilege power that cannot freeze, rewire, or exceed MAX_FAUCET_CREDIT.
    /// @dev One-shot per address (reverts if already a client), so the on-chain credit per
    ///      visitor is capped at MAX_FAUCET_CREDIT regardless of off-chain rate limiting.
    ///      Reuses the genesis events (ClientRegistered, ClientCredited) and the soft ratio
    ///      check — onboarding grows M1 and degrades the ratio, which is realistic.
    /// @param client The visitor's wallet to onboard.
    /// @param amount Test deposits to credit (must be <= MAX_FAUCET_CREDIT).
    function onboard(address client, uint256 amount) external onlyRole(FAUCET_ROLE) {
        if (amount > MAX_FAUCET_CREDIT) revert FaucetAmountTooHigh(amount, MAX_FAUCET_CREDIT);
        if (isClient[client]) revert AlreadyClient(client);
        isClient[client] = true;
        emit ClientRegistered(client);
        depositToken.mint(client, amount);
        emit ClientCredited(client, amount);
        checkReserveRatio();
    }

    /*//////////////////////////////////////////////////////////////
                            FREEZE / UNFREEZE
    //////////////////////////////////////////////////////////////*/

    /// @notice Freezes the bank: all DepositToken movement halts, including settlements.
    function freeze() external onlyRole(OPERATOR_ROLE) {
        depositToken.pause();
        emit BankFrozen();
    }

    /// @notice Unfreezes the bank (resolution).
    function unfreeze() external onlyRole(OPERATOR_ROLE) {
        depositToken.unpause();
        emit BankUnfrozen();
    }

    /*//////////////////////////////////////////////////////////////
                          SETTLEMENT ENGINE WIRING
    //////////////////////////////////////////////////////////////*/

    /// @notice Plugs a SettlementEngine into this bank's deposit token: grants it the
    ///         mint/burn/settle roles, revoking them from the previous engine if any.
    /// @param engine The engine address (address(0) to unplug).
    function setSettlementEngine(address engine) external onlyRole(OPERATOR_ROLE) {
        address previous = settlementEngine;
        if (previous != address(0)) {
            depositToken.revokeRole(depositToken.MINTER_ROLE(), previous);
            depositToken.revokeRole(depositToken.BURNER_ROLE(), previous);
            depositToken.revokeRole(depositToken.SETTLER_ROLE(), previous);
        }
        if (engine != address(0)) {
            depositToken.grantRole(depositToken.MINTER_ROLE(), engine);
            depositToken.grantRole(depositToken.BURNER_ROLE(), engine);
            depositToken.grantRole(depositToken.SETTLER_ROLE(), engine);
        }
        settlementEngine = engine;
        emit SettlementEngineUpdated(previous, engine);
    }

    /*//////////////////////////////////////////////////////////////
                          RESERVES & RATIO
    //////////////////////////////////////////////////////////////*/

    /// @notice The bank's central bank money reserves.
    function reserves() public view returns (uint256) {
        return wcbdc.balanceOf(address(this));
    }

    /// @notice Reserve ratio in basis points: reserves / deposit supply.
    /// @dev Returns type(uint256).max when no deposits exist (trivially covered).
    function reserveRatioBps() public view returns (uint256) {
        uint256 depositSupply = depositToken.totalSupply();
        if (depositSupply == 0) return type(uint256).max;
        return reserves() * BPS_DENOMINATOR / depositSupply;
    }

    /// @notice Emits ReserveRatioBreached if the ratio sits below the regulatory threshold.
    ///         Called after every ratio-degrading operation (outgoing settlement via the
    ///         engine, creditClient) — and by anyone: the data is public, flagging a breach
    ///         is permissionless (transparency paradox).
    /// @dev Soft constraint only (trap #4): never blocks anything, writes nothing.
    function checkReserveRatio() public {
        uint256 ratioBps = reserveRatioBps();
        uint256 thresholdBps = centralBank.reserveRatioThresholdBps();
        if (ratioBps < thresholdBps) {
            emit ReserveRatioBreached(address(this), ratioBps, thresholdBps);
        }
    }
}
