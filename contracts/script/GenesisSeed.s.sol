// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {CommercialBank} from "../src/CommercialBank.sol";
import {DepositToken} from "../src/DepositToken.sol";

/// @title GenesisSeed — shared, idempotent genesis seeding logic
/// @notice Base of both Deploy.s.sol (fresh deployment + seed) and Seed.s.sol (re-seed
///         against an existing deployment). Every step checks on-chain state first, so
///         re-running never double-registers, double-credits or over-funds.
abstract contract GenesisSeed is Script {
    // Genesis constants — see CLAUDE.md "Constants" (recalibrated 2026-06-10)
    uint256 internal constant DEP_CLIENT_1 = 2_400_000e6; // alice1 / bob1
    uint256 internal constant DEP_CLIENT_2 = 1_600_000e6; // alice2 / bob2

    // sETH funding targets (top-up semantics). Relayer amount is a Phase 3 free choice;
    // operator/client amounts come from CLAUDE.md "Constants".
    uint256 internal constant RELAYER_FUNDING = 0.1 ether;
    uint256 internal constant OPERATOR_FUNDING = 0.05 ether;
    uint256 internal constant CLIENT_FUNDING = 0.02 ether;

    /// @notice The actor address universe. Server-signing roles (operators, deployer) are
    ///         derived from their private keys; clients and the relayer are addresses only
    ///         — no client/relayer private key ever reaches the deploy scripts (the relayer
    ///         signs in its own service, clients sign from their wallets / the smoke test).
    struct Actors {
        address centralBankOperator;
        address bankAOperator;
        address bankBOperator;
        address stableCoOperator;
        address alice1;
        address alice2;
        address bob1;
        address bob2;
        address relayer;
    }

    /// @notice Keys of the EOAs that broadcast during deploy/seed. Clients and the relayer
    ///         never broadcast here, so their private keys stay out of these scripts.
    /// @dev The StableCo operator joined this set in Phase 4: it signs the StableCo
    ///      deployment (and pause() at runtime), so it became a server-signing role with
    ///      its own *_PK — consistent with the individual-keys model.
    struct OperatorKeys {
        uint256 deployer;
        uint256 bankAOperator;
        uint256 bankBOperator;
        uint256 stableCoOperator;
    }

    error FundingTransferFailed(address recipient);

    /// @dev Loads the account universe from individual env vars (no HD mnemonic — user
    ///      decision 2026-06-13). `*_PK` for the roles that broadcast (so the script can
    ///      sign as them), `*_ADDRESS` for everyone else. On Sepolia the deploy/operator
    ///      keys should come from an encrypted Foundry keystore instead.
    function _loadActors() internal view returns (Actors memory a, OperatorKeys memory k) {
        k.deployer = vm.envUint("CENTRAL_BANK_OPERATOR_PK");
        k.bankAOperator = vm.envUint("BANK_A_OPERATOR_PK");
        k.bankBOperator = vm.envUint("BANK_B_OPERATOR_PK");
        k.stableCoOperator = vm.envUint("STABLECO_OPERATOR_PK");
        a.centralBankOperator = vm.addr(k.deployer);
        a.bankAOperator = vm.addr(k.bankAOperator);
        a.bankBOperator = vm.addr(k.bankBOperator);
        a.stableCoOperator = vm.addr(k.stableCoOperator);
        a.alice1 = vm.envAddress("ALICE1_ADDRESS");
        a.alice2 = vm.envAddress("ALICE2_ADDRESS");
        a.bob1 = vm.envAddress("BOB1_ADDRESS");
        a.bob2 = vm.envAddress("BOB2_ADDRESS");
        a.relayer = vm.envAddress("RELAYER_ADDRESS");
    }

    /// @dev Registers and credits a bank's two genesis clients, skipping whatever already
    ///      exists. Broadcast by the bank's own operator (institutional action).
    function _seedBankClients(uint256 operatorKey, CommercialBank bank, address client1, address client2) internal {
        DepositToken dep = bank.depositToken();
        vm.startBroadcast(operatorKey);
        if (!bank.isClient(client1)) bank.registerClient(client1);
        if (!bank.isClient(client2)) bank.registerClient(client2);
        if (dep.balanceOf(client1) == 0) bank.creditClient(client1, DEP_CLIENT_1);
        if (dep.balanceOf(client2) == 0) bank.creditClient(client2, DEP_CLIENT_2);
        vm.stopBroadcast();
    }

    /// @dev Grants the narrow FAUCET_ROLE to the relayer on a bank (Option B onboarding),
    ///      idempotently. Signed by the bank operator (admin of the role). The relayer keeps
    ///      its single key; this just lets that key call `onboard` (register + capped credit).
    function _grantFaucet(uint256 operatorKey, CommercialBank bank, address relayer) internal {
        if (bank.hasRole(bank.FAUCET_ROLE(), relayer)) return;
        vm.startBroadcast(operatorKey);
        bank.grantRole(bank.FAUCET_ROLE(), relayer);
        vm.stopBroadcast();
    }

    /// @dev Tops up every funded account to its sETH target from the deployer. Runs
    ///      BEFORE operator broadcasts so they can pay for their own transactions on
    ///      Sepolia. On Anvil the HD accounts are pre-funded, so this no-ops.
    function _fundActors(uint256 deployerKey, Actors memory a) internal {
        // Pure dry-run support (forge script without --rpc-url: chainid 31337, empty
        // state, zero balances everywhere): give the simulated deployer gas money so the
        // funding plan can still be exercised. Never triggers against a live chain —
        // a real Anvil pre-funds the HD accounts, and Sepolia must fail loudly if the
        // deployer cannot cover the distribution.
        address deployer = vm.addr(deployerKey);
        if (block.chainid == 31_337 && deployer.balance == 0) {
            vm.deal(deployer, 10 ether);
        }

        vm.startBroadcast(deployerKey);
        _topUp(a.relayer, RELAYER_FUNDING);
        _topUp(a.bankAOperator, OPERATOR_FUNDING);
        _topUp(a.bankBOperator, OPERATOR_FUNDING);
        _topUp(a.stableCoOperator, OPERATOR_FUNDING);
        _topUp(a.alice1, CLIENT_FUNDING);
        _topUp(a.alice2, CLIENT_FUNDING);
        _topUp(a.bob1, CLIENT_FUNDING);
        _topUp(a.bob2, CLIENT_FUNDING);
        vm.stopBroadcast();
    }

    /// @dev Sends only the missing difference; no-op when the balance already meets the
    ///      target (idempotent re-seeds, and Anvil's pre-funded accounts).
    function _topUp(address recipient, uint256 target) internal {
        uint256 balance = recipient.balance;
        if (balance >= target) return;
        (bool ok,) = payable(recipient).call{value: target - balance}("");
        if (!ok) revert FundingTransferFailed(recipient);
    }

    function _deploymentsPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../deployments/", _chainName(), ".json");
    }

    function _chainName() internal view returns (string memory) {
        if (block.chainid == 31_337) return "local";
        if (block.chainid == 11_155_111) return "sepolia";
        return vm.toString(block.chainid);
    }
}
