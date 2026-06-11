// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {CentralBank} from "../src/CentralBank.sol";
import {WCBDC} from "../src/WCBDC.sol";

/// @title Deploy — genesis deployment skeleton (Phase 1: M0 layer only)
/// @notice Deploys the CentralBank (which deploys the wCBDC) and records addresses +
///         START_BLOCK into deployments/<chain>.json. Later phases extend this script
///         into the full, reproducible, accounting-consistent genesis.
contract Deploy is Script {
    // Genesis constants — see CLAUDE.md "Constants" (recalibrated 2026-06-10)
    uint256 internal constant CBDC_PER_BANK = 500_000e6; // 1_000_000e6 total M0 (INVARIANT 1)
    uint256 internal constant DEP_CLIENT_1 = 2_400_000e6; // alice1 / bob1
    uint256 internal constant DEP_CLIENT_2 = 1_600_000e6; // alice2 / bob2

    function run() external {
        // 8 EOAs from one HD mnemonic, indexes 0-7; index 0 = deployer/centralBankOperator
        string memory mnemonic = vm.envString("MNEMONIC");
        uint256 deployerKey = vm.deriveKey(mnemonic, 0);
        address centralBankOperator = vm.addr(deployerKey);

        uint256 startBlock = block.number;

        vm.startBroadcast(deployerKey);
        CentralBank centralBank = new CentralBank(centralBankOperator);
        vm.stopBroadcast();

        // TODO(Phase 2): deploy CommercialBank A/B + DepositToken A/B + SettlementEngine;
        //                registerBank(A), registerBank(B); mintCBDC(A/B, CBDC_PER_BANK).
        // TODO(Phase 3): full seed — register clients (alice1/2, bob1/2), mint DEP
        //                (DEP_CLIENT_1 / DEP_CLIENT_2 per bank), fund relayer + EOAs.
        // TODO(Phase 4): deploy StableCo + StableEUR; register StableCo as Bank A client.

        WCBDC wcbdc = centralBank.wcbdc();
        console2.log("CentralBank:", address(centralBank));
        console2.log("wCBDC:      ", address(wcbdc));
        console2.log("START_BLOCK:", startBlock);

        _writeDeployments(address(centralBank), address(wcbdc), startBlock);
    }

    /// @dev Trap #6: START_BLOCK is recorded at deploy time so event scans never start
    ///      from block 0 on Sepolia.
    function _writeDeployments(address centralBank, address wcbdc, uint256 startBlock) internal {
        string memory obj = "deployments";
        vm.serializeAddress(obj, "centralBank", centralBank);
        vm.serializeAddress(obj, "wcbdc", wcbdc);
        string memory json = vm.serializeUint(obj, "startBlock", startBlock);
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
