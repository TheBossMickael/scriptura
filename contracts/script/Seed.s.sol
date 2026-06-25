// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {CommercialBank} from "../src/CommercialBank.sol";
import {GenesisSeed} from "./GenesisSeed.s.sol";

/// @title Seed — standalone idempotent re-seed against an existing deployment
/// @notice Reads deployments/<chain>.json and replays the genesis seed: client
///         registration, DEP credit and sETH funding — skipping whatever already holds.
///         Useful to top up drained gas balances on Sepolia (or finish an interrupted
///         seed) without redeploying; running it on a fully seeded system sends nothing.
contract Seed is GenesisSeed {
    function run() external {
        (Actors memory actors, OperatorKeys memory keys) = _loadActors();

        string memory json = vm.readFile(_deploymentsPath());
        CommercialBank bankA = CommercialBank(vm.parseJsonAddress(json, ".bankA"));
        CommercialBank bankB = CommercialBank(vm.parseJsonAddress(json, ".bankB"));

        _fundActors(keys.deployer, actors);
        _seedBankClients(keys.bankAOperator, bankA, actors.alice1, actors.alice2);
        _seedBankClients(keys.bankBOperator, bankB, actors.bob1, actors.bob2);

        console2.log("Seed completed against:", _deploymentsPath());
    }
}
