// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {CentralBank} from "../src/CentralBank.sol";
import {CommercialBank} from "../src/CommercialBank.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {WCBDC} from "../src/WCBDC.sol";

/// @title Deploy — genesis deployment (Phase 2: M0 + M1 layers and settlement wiring)
/// @notice Deploys CentralBank (which deploys the wCBDC), both CommercialBanks (which
///         deploy their DepositTokens), the SettlementEngine, wires the settlement roles,
///         issues genesis M0, and records addresses + START_BLOCK into
///         deployments/<chain>.json. Later phases extend this into the full seed.
contract Deploy is Script {
    // Genesis constants — see CLAUDE.md "Constants" (recalibrated 2026-06-10)
    uint256 internal constant CBDC_PER_BANK = 500_000e6; // 1_000_000e6 total M0 (INVARIANT 1)
    uint256 internal constant DEP_CLIENT_1 = 2_400_000e6; // alice1 / bob1
    uint256 internal constant DEP_CLIENT_2 = 1_600_000e6; // alice2 / bob2

    struct Deployed {
        CentralBank centralBank;
        WCBDC wcbdc;
        CommercialBank bankA;
        CommercialBank bankB;
        SettlementEngine engine;
        uint256 startBlock;
    }

    function run() external {
        // 8 EOAs from one HD mnemonic, indexes 0-7; index 0 = deployer/centralBankOperator
        string memory mnemonic = vm.envString("MNEMONIC");
        uint256 deployerKey = vm.deriveKey(mnemonic, 0);
        uint256 bankAOperatorKey = vm.deriveKey(mnemonic, 1);
        uint256 bankBOperatorKey = vm.deriveKey(mnemonic, 2);
        address centralBankOperator = vm.addr(deployerKey);
        address bankAOperator = vm.addr(bankAOperatorKey);
        address bankBOperator = vm.addr(bankBOperatorKey);

        Deployed memory d;
        d.startBlock = block.number;

        // Institutional deployment + M0 genesis (central bank operator).
        vm.startBroadcast(deployerKey);
        d.centralBank = new CentralBank(centralBankOperator);
        d.wcbdc = d.centralBank.wcbdc();
        d.bankA = new CommercialBank(bankAOperator, d.centralBank, "Bank A Deposit", "DEP-A");
        d.bankB = new CommercialBank(bankBOperator, d.centralBank, "Bank B Deposit", "DEP-B");
        d.engine = new SettlementEngine(d.centralBank);
        d.centralBank.registerBank(address(d.bankA));
        d.centralBank.registerBank(address(d.bankB));
        d.centralBank.mintCBDC(address(d.bankA), CBDC_PER_BANK);
        d.centralBank.mintCBDC(address(d.bankB), CBDC_PER_BANK);
        d.centralBank.setSettlementEngine(address(d.engine));
        vm.stopBroadcast();

        // Each bank opts into the settlement infrastructure with its own operator key.
        vm.startBroadcast(bankAOperatorKey);
        d.bankA.setSettlementEngine(address(d.engine));
        vm.stopBroadcast();

        vm.startBroadcast(bankBOperatorKey);
        d.bankB.setSettlementEngine(address(d.engine));
        vm.stopBroadcast();

        // TODO(Phase 3): full seed — register clients (alice1/2, bob1/2), credit DEP
        //                (DEP_CLIENT_1 / DEP_CLIENT_2 per bank), fund relayer + EOAs.
        // TODO(Phase 4): deploy StableCo + StableEUR; register StableCo as Bank A client.

        console2.log("CentralBank:     ", address(d.centralBank));
        console2.log("wCBDC:           ", address(d.wcbdc));
        console2.log("Bank A:          ", address(d.bankA));
        console2.log("DEP-A:           ", address(d.bankA.depositToken()));
        console2.log("Bank B:          ", address(d.bankB));
        console2.log("DEP-B:           ", address(d.bankB.depositToken()));
        console2.log("SettlementEngine:", address(d.engine));
        console2.log("START_BLOCK:     ", d.startBlock);

        _writeDeployments(d);
    }

    /// @dev Trap #6: START_BLOCK is recorded at deploy time so event scans never start
    ///      from block 0 on Sepolia.
    function _writeDeployments(Deployed memory d) internal {
        string memory obj = "deployments";
        vm.serializeAddress(obj, "centralBank", address(d.centralBank));
        vm.serializeAddress(obj, "wcbdc", address(d.wcbdc));
        vm.serializeAddress(obj, "bankA", address(d.bankA));
        vm.serializeAddress(obj, "depA", address(d.bankA.depositToken()));
        vm.serializeAddress(obj, "bankB", address(d.bankB));
        vm.serializeAddress(obj, "depB", address(d.bankB.depositToken()));
        vm.serializeAddress(obj, "settlementEngine", address(d.engine));
        string memory json = vm.serializeUint(obj, "startBlock", d.startBlock);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", _chainName(), ".json");
        vm.writeJson(json, path);
        console2.log("Deployment file written:", path);
    }

    function _chainName() internal view returns (string memory) {
        if (block.chainid == 31_337) return "local";
        if (block.chainid == 11_155_111) return "sepolia";
        return vm.toString(block.chainid);
    }
}
