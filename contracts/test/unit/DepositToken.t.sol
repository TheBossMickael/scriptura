// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {DepositToken} from "../../src/DepositToken.sol";

/// @dev Stands in for the owning CommercialBank: exposes the same `isClient` getter the
///      token hook queries, without dragging the full bank stack into unit tests.
contract ClientRegistryMock {
    mapping(address account => bool) public isClient;

    function setClient(address account, bool registered) external {
        isClient[account] = registered;
    }
}

contract DepositTokenTest is Test {
    DepositToken internal dep;
    ClientRegistryMock internal registry;

    address internal bank; // the registry mock plays the owning CommercialBank
    address internal engine = makeAddr("engine"); // plays the SettlementEngine
    address internal alice1 = makeAddr("alice1");
    address internal alice2 = makeAddr("alice2");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        registry = new ClientRegistryMock();
        bank = address(registry);
        dep = new DepositToken("Bank A Deposit", "DEP-A", bank);

        registry.setClient(alice1, true);
        registry.setClient(alice2, true);

        vm.startPrank(bank);
        dep.grantRole(dep.MINTER_ROLE(), engine);
        dep.grantRole(dep.BURNER_ROLE(), engine);
        dep.grantRole(dep.SETTLER_ROLE(), engine);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                METADATA
    //////////////////////////////////////////////////////////////*/

    function test_Decimals_IsSix() public view {
        assertEq(dep.decimals(), 6);
    }

    function test_Constructor_GrantsRolesToBank() public view {
        assertTrue(dep.hasRole(dep.DEFAULT_ADMIN_ROLE(), bank));
        assertTrue(dep.hasRole(dep.PAUSER_ROLE(), bank));
        assertTrue(dep.hasRole(dep.MINTER_ROLE(), bank));
        assertEq(address(dep.bank()), bank);
    }

    /*//////////////////////////////////////////////////////////////
                                TRANSFER
    //////////////////////////////////////////////////////////////*/

    function test_Transfer_BetweenClients() public {
        vm.prank(engine);
        dep.mint(alice1, 100e6);

        vm.prank(alice1);
        dep.transfer(alice2, 40e6);

        assertEq(dep.balanceOf(alice1), 60e6);
        assertEq(dep.balanceOf(alice2), 40e6);
    }

    function test_RevertWhen_TransferToNonClient() public {
        vm.prank(engine);
        dep.mint(alice1, 100e6);

        vm.expectRevert(abi.encodeWithSelector(DepositToken.NotClient.selector, stranger));
        vm.prank(alice1);
        dep.transfer(stranger, 1e6);
    }

    function test_RevertWhen_TransferFromRemovedClient() public {
        vm.prank(engine);
        dep.mint(alice1, 100e6);
        registry.setClient(alice1, false);

        vm.expectRevert(abi.encodeWithSelector(DepositToken.NotClient.selector, alice1));
        vm.prank(alice1);
        dep.transfer(alice2, 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                                  MINT
    //////////////////////////////////////////////////////////////*/

    function test_Mint_ToClient() public {
        vm.prank(engine);
        dep.mint(alice1, 100e6);
        assertEq(dep.balanceOf(alice1), 100e6);
        assertEq(dep.totalSupply(), 100e6);
    }

    function test_RevertWhen_MintToNonClient() public {
        vm.expectRevert(abi.encodeWithSelector(DepositToken.NotClient.selector, stranger));
        vm.prank(engine);
        dep.mint(stranger, 1e6);
    }

    function test_RevertWhen_MintWithoutMinterRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, dep.MINTER_ROLE()
            )
        );
        vm.prank(stranger);
        dep.mint(alice1, 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                                  BURN
    //////////////////////////////////////////////////////////////*/

    function test_Burn_ByBurnerRole() public {
        vm.prank(engine);
        dep.mint(alice1, 100e6);

        vm.prank(engine);
        dep.burn(alice1, 40e6);

        assertEq(dep.balanceOf(alice1), 60e6);
        assertEq(dep.totalSupply(), 60e6);
    }

    function test_RevertWhen_BurnWithoutBurnerRole() public {
        vm.prank(engine);
        dep.mint(alice1, 100e6);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, dep.BURNER_ROLE()
            )
        );
        vm.prank(stranger);
        dep.burn(alice1, 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                                 SETTLE
    //////////////////////////////////////////////////////////////*/

    function test_Settle_MovesDepositsWithoutAllowance() public {
        vm.prank(engine);
        dep.mint(alice1, 100e6);

        vm.prank(engine);
        dep.settle(alice1, alice2, 70e6);

        assertEq(dep.balanceOf(alice1), 30e6);
        assertEq(dep.balanceOf(alice2), 70e6);
        assertEq(dep.totalSupply(), 100e6); // book transfer: supply untouched
    }

    function test_RevertWhen_SettleWithoutSettlerRole() public {
        vm.prank(engine);
        dep.mint(alice1, 100e6);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, dep.SETTLER_ROLE()
            )
        );
        vm.prank(stranger);
        dep.settle(alice1, alice2, 1e6);
    }

    function test_RevertWhen_SettleToNonClient() public {
        // The holder restriction hook also applies to the engine's settle path.
        vm.prank(engine);
        dep.mint(alice1, 100e6);

        vm.expectRevert(abi.encodeWithSelector(DepositToken.NotClient.selector, stranger));
        vm.prank(engine);
        dep.settle(alice1, stranger, 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                             PAUSE (FREEZE)
    //////////////////////////////////////////////////////////////*/

    function test_Pause_BlocksEveryMovementPath() public {
        vm.prank(engine);
        dep.mint(alice1, 100e6);

        vm.prank(bank);
        dep.pause();
        assertTrue(dep.paused());

        // Freeze blocks clients AND the engine: transfer, mint, burn, settle all revert.
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice1);
        dep.transfer(alice2, 1e6);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(engine);
        dep.mint(alice2, 1e6);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(engine);
        dep.burn(alice1, 1e6);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(engine);
        dep.settle(alice1, alice2, 1e6);
    }

    function test_Unpause_RestoresMovement() public {
        vm.prank(engine);
        dep.mint(alice1, 100e6);

        vm.prank(bank);
        dep.pause();
        vm.prank(bank);
        dep.unpause();
        assertFalse(dep.paused());

        vm.prank(alice1);
        dep.transfer(alice2, 10e6);
        assertEq(dep.balanceOf(alice2), 10e6);
    }

    function test_RevertWhen_PauseWithoutPauserRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, dep.PAUSER_ROLE()
            )
        );
        vm.prank(stranger);
        dep.pause();
    }
}
