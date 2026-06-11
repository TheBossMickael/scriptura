// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {CentralBank} from "../../src/CentralBank.sol";
import {WCBDC} from "../../src/WCBDC.sol";

contract CentralBankTest is Test {
    CentralBank internal centralBank;
    WCBDC internal wcbdc;

    address internal operator = makeAddr("operator"); // centralBankOperator EOA
    address internal bankA = makeAddr("bankA");
    address internal bankB = makeAddr("bankB");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        centralBank = new CentralBank(operator);
        wcbdc = centralBank.wcbdc();
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_DeploysWCBDCWithCentralBankAsAdmin() public view {
        assertTrue(wcbdc.hasRole(wcbdc.DEFAULT_ADMIN_ROLE(), address(centralBank)));
        assertTrue(wcbdc.hasRole(wcbdc.MINTER_ROLE(), address(centralBank)));
        assertTrue(wcbdc.hasRole(wcbdc.BURNER_ROLE(), address(centralBank)));
        assertFalse(wcbdc.hasRole(wcbdc.DEFAULT_ADMIN_ROLE(), operator));
    }

    function test_Constructor_GrantsRolesToOperator() public view {
        assertTrue(centralBank.hasRole(centralBank.DEFAULT_ADMIN_ROLE(), operator));
        assertTrue(centralBank.hasRole(centralBank.OPERATOR_ROLE(), operator));
    }

    function test_Constructor_SetsInitialThresholdAtTenPercent() public view {
        assertEq(centralBank.reserveRatioThresholdBps(), 1_000);
    }

    /*//////////////////////////////////////////////////////////////
                            BANK REGISTRY
    //////////////////////////////////////////////////////////////*/

    function test_RegisterBank_UpdatesAllowlist() public {
        vm.expectEmit(true, false, false, false);
        emit CentralBank.BankRegistered(bankA);
        vm.prank(operator);
        centralBank.registerBank(bankA);

        assertTrue(wcbdc.isAllowlisted(bankA));
        assertTrue(centralBank.isRegisteredBank(bankA));
    }

    function test_RemoveBank_UpdatesAllowlist() public {
        vm.prank(operator);
        centralBank.registerBank(bankA);

        vm.expectEmit(true, false, false, false);
        emit CentralBank.BankRemoved(bankA);
        vm.prank(operator);
        centralBank.removeBank(bankA);

        assertFalse(centralBank.isRegisteredBank(bankA));
    }

    function test_RevertWhen_RegisterBankWithoutOperatorRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, centralBank.OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        centralBank.registerBank(bankA);
    }

    /*//////////////////////////////////////////////////////////////
                             M0 ISSUANCE
    //////////////////////////////////////////////////////////////*/

    function test_MintCBDC_ToRegisteredBank() public {
        vm.prank(operator);
        centralBank.registerBank(bankA);

        vm.expectEmit(true, false, false, true);
        emit CentralBank.CBDCMinted(bankA, 500_000e6);
        vm.prank(operator);
        centralBank.mintCBDC(bankA, 500_000e6);

        assertEq(wcbdc.balanceOf(bankA), 500_000e6);
    }

    function test_RevertWhen_MintCBDCToUnregisteredBank() public {
        vm.expectRevert(abi.encodeWithSelector(WCBDC.NotAllowlisted.selector, bankA));
        vm.prank(operator);
        centralBank.mintCBDC(bankA, 1e6);
    }

    function test_RevertWhen_MintCBDCWithoutOperatorRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, centralBank.OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        centralBank.mintCBDC(bankA, 1e6);
    }

    function test_BurnCBDC_FromBank() public {
        vm.startPrank(operator);
        centralBank.registerBank(bankA);
        centralBank.mintCBDC(bankA, 100e6);

        vm.expectEmit(true, false, false, true);
        emit CentralBank.CBDCBurned(bankA, 40e6);
        centralBank.burnCBDC(bankA, 40e6);
        vm.stopPrank();

        assertEq(wcbdc.balanceOf(bankA), 60e6);
        assertEq(wcbdc.totalSupply(), 60e6);
    }

    function test_RevertWhen_BurnCBDCWithoutOperatorRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, centralBank.OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        centralBank.burnCBDC(bankA, 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                        REGULATORY RATIO PARAMETER
    //////////////////////////////////////////////////////////////*/

    function test_SetReserveRatioThreshold_UpdatesValue() public {
        vm.expectEmit(false, false, false, true);
        emit CentralBank.ReserveRatioThresholdUpdated(1_000, 1_500);
        vm.prank(operator);
        centralBank.setReserveRatioThreshold(1_500);

        assertEq(centralBank.reserveRatioThresholdBps(), 1_500);
    }

    function test_RevertWhen_ThresholdAboveMax() public {
        vm.expectRevert(abi.encodeWithSelector(CentralBank.ThresholdAboveMax.selector, 10_001));
        vm.prank(operator);
        centralBank.setReserveRatioThreshold(10_001);
    }

    function test_RevertWhen_SetThresholdWithoutOperatorRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, centralBank.OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        centralBank.setReserveRatioThreshold(500);
    }

    /*//////////////////////////////////////////////////////////////
                           GENESIS SCENARIO
    //////////////////////////////////////////////////////////////*/

    function test_GenesisScenario_TotalSupplyOneMillion() public {
        // INVARIANT 1: after genesis, wCBDC.totalSupply() == 1_000_000e6, constant in V1.
        vm.startPrank(operator);
        centralBank.registerBank(bankA);
        centralBank.registerBank(bankB);
        centralBank.mintCBDC(bankA, 500_000e6);
        centralBank.mintCBDC(bankB, 500_000e6);
        vm.stopPrank();

        assertEq(wcbdc.balanceOf(bankA), 500_000e6);
        assertEq(wcbdc.balanceOf(bankB), 500_000e6);
        assertEq(wcbdc.totalSupply(), 1_000_000e6);
    }
}
