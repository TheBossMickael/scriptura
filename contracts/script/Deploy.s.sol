// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {CentralBank} from "../src/CentralBank.sol";
import {CommercialBank} from "../src/CommercialBank.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {WCBDC} from "../src/WCBDC.sol";
import {GenesisSeed} from "./GenesisSeed.s.sol";

/// @title Deploy — full genesis deployment (Phase 3: complete seed)
/// @notice Deploys CentralBank (which deploys the wCBDC), both CommercialBanks (which
///         deploy their DepositTokens), the SettlementEngine; wires the settlement roles;
///         issues genesis M0; funds the actor EOAs and the relayer; registers and credits
///         the four genesis clients; records contract + actor addresses, chainId and
///         START_BLOCK into deployments/<chain>.json.
contract Deploy is GenesisSeed {
    uint256 internal constant CBDC_PER_BANK = 500_000e6; // 1_000_000e6 total M0 (INVARIANT 1)

    struct Deployed {
        CentralBank centralBank;
        WCBDC wcbdc;
        CommercialBank bankA;
        CommercialBank bankB;
        SettlementEngine engine;
        uint256 startBlock;
    }

    function run() external {
        (Actors memory actors, OperatorKeys memory keys) = _loadActors();

        Deployed memory d;
        d.startBlock = block.number;

        // Institutional deployment + M0 genesis (central bank operator).
        vm.startBroadcast(keys.deployer);
        d.centralBank = new CentralBank(actors.centralBankOperator);
        d.wcbdc = d.centralBank.wcbdc();
        d.bankA = new CommercialBank(actors.bankAOperator, d.centralBank, "Bank A Deposit", "DEP-A");
        d.bankB = new CommercialBank(actors.bankBOperator, d.centralBank, "Bank B Deposit", "DEP-B");
        d.engine = new SettlementEngine(d.centralBank);
        d.centralBank.registerBank(address(d.bankA));
        d.centralBank.registerBank(address(d.bankB));
        d.centralBank.mintCBDC(address(d.bankA), CBDC_PER_BANK);
        d.centralBank.mintCBDC(address(d.bankB), CBDC_PER_BANK);
        d.centralBank.setSettlementEngine(address(d.engine));
        vm.stopBroadcast();

        // sETH distribution first: on Sepolia the operators need gas for the broadcasts
        // below (no-op on Anvil where HD accounts are pre-funded).
        _fundActors(keys.deployer, actors);

        // Each bank opts into the settlement infrastructure with its own operator key,
        // then onboards and credits its two genesis clients (12.5% initial ratio).
        vm.startBroadcast(keys.bankAOperator);
        d.bankA.setSettlementEngine(address(d.engine));
        vm.stopBroadcast();
        _seedBankClients(keys.bankAOperator, d.bankA, actors.alice1, actors.alice2);

        vm.startBroadcast(keys.bankBOperator);
        d.bankB.setSettlementEngine(address(d.engine));
        vm.stopBroadcast();
        _seedBankClients(keys.bankBOperator, d.bankB, actors.bob1, actors.bob2);

        // TODO(Phase 4): deploy StableCo + StableEUR; register StableCo as Bank A client.

        console2.log("CentralBank:     ", address(d.centralBank));
        console2.log("wCBDC:           ", address(d.wcbdc));
        console2.log("Bank A:          ", address(d.bankA));
        console2.log("DEP-A:           ", address(d.bankA.depositToken()));
        console2.log("Bank B:          ", address(d.bankB));
        console2.log("DEP-B:           ", address(d.bankB.depositToken()));
        console2.log("SettlementEngine:", address(d.engine));
        console2.log("Relayer:         ", actors.relayer);
        console2.log("START_BLOCK:     ", d.startBlock);

        _writeDeployments(d, actors);
    }

    /// @dev Trap #6: START_BLOCK is recorded at deploy time so event scans never start
    ///      from block 0 on Sepolia. Actor addresses and chainId are included for the
    ///      relayer (EIP-712 domain, sanity checks) and the Phase 5 directory.ts.
    function _writeDeployments(Deployed memory d, Actors memory actors) internal {
        string memory obj = "deployments";
        vm.serializeAddress(obj, "centralBank", address(d.centralBank));
        vm.serializeAddress(obj, "wcbdc", address(d.wcbdc));
        vm.serializeAddress(obj, "bankA", address(d.bankA));
        vm.serializeAddress(obj, "depA", address(d.bankA.depositToken()));
        vm.serializeAddress(obj, "bankB", address(d.bankB));
        vm.serializeAddress(obj, "depB", address(d.bankB.depositToken()));
        vm.serializeAddress(obj, "settlementEngine", address(d.engine));
        vm.serializeAddress(obj, "centralBankOperator", actors.centralBankOperator);
        vm.serializeAddress(obj, "bankAOperator", actors.bankAOperator);
        vm.serializeAddress(obj, "bankBOperator", actors.bankBOperator);
        vm.serializeAddress(obj, "stableCoOperator", actors.stableCoOperator);
        vm.serializeAddress(obj, "alice1", actors.alice1);
        vm.serializeAddress(obj, "alice2", actors.alice2);
        vm.serializeAddress(obj, "bob1", actors.bob1);
        vm.serializeAddress(obj, "bob2", actors.bob2);
        vm.serializeAddress(obj, "relayer", actors.relayer);
        vm.serializeUint(obj, "chainId", block.chainid);
        string memory json = vm.serializeUint(obj, "startBlock", d.startBlock);
        string memory path = _deploymentsPath();
        vm.writeJson(json, path);
        console2.log("Deployment file written:", path);
    }
}
