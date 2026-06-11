// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {WCBDC} from "../../src/WCBDC.sol";

contract WCBDCTest is Test {
    WCBDC internal wcbdc;

    address internal admin = makeAddr("admin"); // plays the CentralBank contract
    address internal bankA = makeAddr("bankA");
    address internal bankB = makeAddr("bankB");
    address internal settler = makeAddr("settler"); // plays the SettlementEngine
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        wcbdc = new WCBDC(admin);
        vm.startPrank(admin);
        wcbdc.setAllowlisted(bankA, true);
        wcbdc.setAllowlisted(bankB, true);
        wcbdc.grantRole(wcbdc.SETTLER_ROLE(), settler);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                METADATA
    //////////////////////////////////////////////////////////////*/

    function test_Decimals_IsSix() public view {
        assertEq(wcbdc.decimals(), 6);
    }

    function test_Constructor_GrantsRolesToAdmin() public view {
        assertTrue(wcbdc.hasRole(wcbdc.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(wcbdc.hasRole(wcbdc.MINTER_ROLE(), admin));
        assertTrue(wcbdc.hasRole(wcbdc.BURNER_ROLE(), admin));
    }

    /*//////////////////////////////////////////////////////////////
                                ALLOWLIST
    //////////////////////////////////////////////////////////////*/

    function test_SetAllowlisted_EmitsEvent() public {
        address newBank = makeAddr("newBank");
        vm.expectEmit(true, false, false, true);
        emit WCBDC.AllowlistUpdated(newBank, true);
        vm.prank(admin);
        wcbdc.setAllowlisted(newBank, true);
        assertTrue(wcbdc.isAllowlisted(newBank));
    }

    function test_SetAllowlisted_CanRevoke() public {
        vm.expectEmit(true, false, false, true);
        emit WCBDC.AllowlistUpdated(bankA, false);
        vm.prank(admin);
        wcbdc.setAllowlisted(bankA, false);
        assertFalse(wcbdc.isAllowlisted(bankA));
    }

    function test_RevertWhen_SetAllowlistedWithoutAdminRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, wcbdc.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(stranger);
        wcbdc.setAllowlisted(stranger, true);
    }

    /*//////////////////////////////////////////////////////////////
                                  MINT
    //////////////////////////////////////////////////////////////*/

    function test_Mint_ToAllowlistedBank() public {
        vm.prank(admin);
        wcbdc.mint(bankA, 500_000e6);
        assertEq(wcbdc.balanceOf(bankA), 500_000e6);
        assertEq(wcbdc.totalSupply(), 500_000e6);
    }

    function test_RevertWhen_MintToNonAllowlisted() public {
        vm.expectRevert(abi.encodeWithSelector(WCBDC.NotAllowlisted.selector, stranger));
        vm.prank(admin);
        wcbdc.mint(stranger, 1e6);
    }

    function test_RevertWhen_MintWithoutMinterRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, wcbdc.MINTER_ROLE()
            )
        );
        vm.prank(stranger);
        wcbdc.mint(bankA, 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                                TRANSFER
    //////////////////////////////////////////////////////////////*/

    function test_Transfer_BetweenAllowlistedBanks() public {
        vm.prank(admin);
        wcbdc.mint(bankA, 100e6);

        vm.prank(bankA);
        wcbdc.transfer(bankB, 40e6);

        assertEq(wcbdc.balanceOf(bankA), 60e6);
        assertEq(wcbdc.balanceOf(bankB), 40e6);
    }

    function test_TransferFrom_WithApprovalBetweenAllowlistedBanks() public {
        vm.prank(admin);
        wcbdc.mint(bankA, 100e6);

        address spender = makeAddr("spender");
        vm.prank(bankA);
        wcbdc.approve(spender, 30e6);

        vm.prank(spender);
        wcbdc.transferFrom(bankA, bankB, 30e6);

        assertEq(wcbdc.balanceOf(bankB), 30e6);
    }

    function test_RevertWhen_TransferToNonAllowlisted() public {
        vm.prank(admin);
        wcbdc.mint(bankA, 100e6);

        vm.expectRevert(abi.encodeWithSelector(WCBDC.NotAllowlisted.selector, stranger));
        vm.prank(bankA);
        wcbdc.transfer(stranger, 1e6);
    }

    function test_RevertWhen_TransferFromRemovedBank() public {
        vm.prank(admin);
        wcbdc.mint(bankA, 100e6);
        vm.prank(admin);
        wcbdc.setAllowlisted(bankA, false);

        vm.expectRevert(abi.encodeWithSelector(WCBDC.NotAllowlisted.selector, bankA));
        vm.prank(bankA);
        wcbdc.transfer(bankB, 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                                  BURN
    //////////////////////////////////////////////////////////////*/

    function test_Burn_ByBurnerRole() public {
        vm.prank(admin);
        wcbdc.mint(bankA, 100e6);
        vm.prank(admin);
        wcbdc.burn(bankA, 40e6);
        assertEq(wcbdc.balanceOf(bankA), 60e6);
        assertEq(wcbdc.totalSupply(), 60e6);
    }

    function test_Burn_FromRemovedBank() public {
        // Documented choice: burns stay possible after allowlist removal, so the central
        // bank can wind down a removed bank's stranded reserves.
        vm.prank(admin);
        wcbdc.mint(bankA, 100e6);
        vm.prank(admin);
        wcbdc.setAllowlisted(bankA, false);

        vm.prank(admin);
        wcbdc.burn(bankA, 100e6);
        assertEq(wcbdc.balanceOf(bankA), 0);
    }

    function test_RevertWhen_BurnWithoutBurnerRole() public {
        vm.prank(admin);
        wcbdc.mint(bankA, 100e6);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, wcbdc.BURNER_ROLE()
            )
        );
        vm.prank(stranger);
        wcbdc.burn(bankA, 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                                 SETTLE
    //////////////////////////////////////////////////////////////*/

    function test_Settle_MovesReservesWithoutAllowance() public {
        vm.prank(admin);
        wcbdc.mint(bankA, 100e6);

        vm.prank(settler);
        wcbdc.settle(bankA, bankB, 70e6);

        assertEq(wcbdc.balanceOf(bankA), 30e6);
        assertEq(wcbdc.balanceOf(bankB), 70e6);
    }

    function test_RevertWhen_SettleWithoutSettlerRole() public {
        vm.prank(admin);
        wcbdc.mint(bankA, 100e6);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, wcbdc.SETTLER_ROLE()
            )
        );
        vm.prank(stranger);
        wcbdc.settle(bankA, bankB, 1e6);
    }

    function test_RevertWhen_SettleToNonAllowlisted() public {
        vm.prank(admin);
        wcbdc.mint(bankA, 100e6);

        vm.expectRevert(abi.encodeWithSelector(WCBDC.NotAllowlisted.selector, stranger));
        vm.prank(settler);
        wcbdc.settle(bankA, stranger, 1e6);
    }
}
