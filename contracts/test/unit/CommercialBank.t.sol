// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {CentralBank} from "../../src/CentralBank.sol";
import {CommercialBank} from "../../src/CommercialBank.sol";
import {DepositToken} from "../../src/DepositToken.sol";
import {WCBDC} from "../../src/WCBDC.sol";

contract CommercialBankTest is Test {
    CentralBank internal centralBank;
    CommercialBank internal bank;
    DepositToken internal dep;
    WCBDC internal wcbdc;

    address internal cbOperator = makeAddr("centralBankOperator");
    address internal operator = makeAddr("bankAOperator");
    address internal engine = makeAddr("engine");
    address internal alice1 = makeAddr("alice1");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant BREACH_TOPIC = keccak256("ReserveRatioBreached(address,uint256,uint256)");

    function setUp() public {
        centralBank = new CentralBank(cbOperator);
        wcbdc = centralBank.wcbdc();
        bank = new CommercialBank(operator, centralBank, "Bank A Deposit", "DEP-A");
        dep = bank.depositToken();
    }

    /// @dev Registers the bank and gives it `amount` of wCBDC reserves.
    function _fundReserves(uint256 amount) internal {
        vm.startPrank(cbOperator);
        centralBank.registerBank(address(bank));
        centralBank.mintCBDC(address(bank), amount);
        vm.stopPrank();
    }

    /// @dev Grants FAUCET_ROLE to `faucet`. Reads the role BEFORE pranking — vm.prank binds
    ///      to the next external call, which would otherwise be the FAUCET_ROLE() view.
    function _grantFaucet(address faucet) internal {
        bytes32 faucetRole = bank.FAUCET_ROLE();
        vm.prank(operator);
        bank.grantRole(faucetRole, faucet);
    }

    /// @dev Counts ReserveRatioBreached entries among recorded logs.
    function _breachLogCount() internal returns (uint256 count) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == BREACH_TOPIC) count++;
        }
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_DeploysDepositTokenWithBankAsAdmin() public view {
        assertEq(dep.name(), "Bank A Deposit");
        assertEq(dep.symbol(), "DEP-A");
        assertEq(address(dep.bank()), address(bank));
        assertTrue(dep.hasRole(dep.DEFAULT_ADMIN_ROLE(), address(bank)));
        assertTrue(dep.hasRole(dep.PAUSER_ROLE(), address(bank)));
        assertTrue(dep.hasRole(dep.MINTER_ROLE(), address(bank)));
        assertFalse(dep.hasRole(dep.DEFAULT_ADMIN_ROLE(), operator));
    }

    function test_Constructor_GrantsRolesToOperator() public view {
        assertTrue(bank.hasRole(bank.DEFAULT_ADMIN_ROLE(), operator));
        assertTrue(bank.hasRole(bank.OPERATOR_ROLE(), operator));
    }

    function test_Constructor_WiresWCBDCFromCentralBank() public view {
        assertEq(address(bank.wcbdc()), address(wcbdc));
        assertEq(address(bank.centralBank()), address(centralBank));
    }

    /*//////////////////////////////////////////////////////////////
                            CLIENT REGISTRY
    //////////////////////////////////////////////////////////////*/

    function test_RegisterClient_EmitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit CommercialBank.ClientRegistered(alice1);
        vm.prank(operator);
        bank.registerClient(alice1);
        assertTrue(bank.isClient(alice1));
    }

    function test_RevertWhen_RegisterClientTwice() public {
        vm.prank(operator);
        bank.registerClient(alice1);

        vm.expectRevert(abi.encodeWithSelector(CommercialBank.AlreadyClient.selector, alice1));
        vm.prank(operator);
        bank.registerClient(alice1);
    }

    function test_RevertWhen_RegisterClientWithoutOperatorRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bank.OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        bank.registerClient(alice1);
    }

    function test_RemoveClient_EmitsEvent() public {
        vm.prank(operator);
        bank.registerClient(alice1);

        vm.expectEmit(true, false, false, false);
        emit CommercialBank.ClientRemoved(alice1);
        vm.prank(operator);
        bank.removeClient(alice1);
        assertFalse(bank.isClient(alice1));
    }

    function test_RevertWhen_RemoveNonClient() public {
        vm.expectRevert(abi.encodeWithSelector(CommercialBank.NotClient.selector, alice1));
        vm.prank(operator);
        bank.removeClient(alice1);
    }

    function test_RevertWhen_RemoveClientWithBalance() public {
        // INVARIANT 5 guard: a removed client could neither transfer nor be settled out,
        // stranding deposits outside the registry.
        vm.startPrank(operator);
        bank.registerClient(alice1);
        bank.creditClient(alice1, 100e6);

        vm.expectRevert(abi.encodeWithSelector(CommercialBank.ClientHasBalance.selector, alice1, 100e6));
        bank.removeClient(alice1);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                            CREDIT CLIENT
    //////////////////////////////////////////////////////////////*/

    function test_CreditClient_MintsAndEmits() public {
        vm.prank(operator);
        bank.registerClient(alice1);

        vm.expectEmit(true, false, false, true);
        emit CommercialBank.ClientCredited(alice1, 100e6);
        vm.prank(operator);
        bank.creditClient(alice1, 100e6);

        assertEq(dep.balanceOf(alice1), 100e6);
        assertEq(dep.totalSupply(), 100e6);
    }

    function test_RevertWhen_CreditNonClient() public {
        vm.expectRevert(abi.encodeWithSelector(DepositToken.NotClient.selector, stranger));
        vm.prank(operator);
        bank.creditClient(stranger, 1e6);
    }

    function test_RevertWhen_CreditWithoutOperatorRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bank.OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        bank.creditClient(alice1, 1e6);
    }

    function test_CreditClient_EmitsBreachBelowThreshold() public {
        // Reserves 100, deposits 900 -> 11.11% (fine); +200 -> 1_100 -> 9.09% < 10%.
        // Credit creation degrades the ratio, so it must alert — but stays soft: the
        // mint goes through regardless (same rule as settlements, trap #4).
        _fundReserves(100e6);
        vm.startPrank(operator);
        bank.registerClient(alice1);
        bank.creditClient(alice1, 900e6);

        vm.expectEmit(true, false, false, true, address(bank));
        emit CommercialBank.ReserveRatioBreached(address(bank), 909, 1_000);
        bank.creditClient(alice1, 200e6);
        vm.stopPrank();

        assertEq(dep.balanceOf(alice1), 1_100e6); // soft constraint: minted anyway
    }

    function test_CreditClient_NoBreachAboveThreshold() public {
        _fundReserves(100e6);
        vm.prank(operator);
        bank.registerClient(alice1);

        vm.recordLogs();
        vm.prank(operator);
        bank.creditClient(alice1, 900e6); // ratio 11.11% >= 10%
        assertEq(_breachLogCount(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                         FAUCET ONBOARDING (Option B)
    //////////////////////////////////////////////////////////////*/

    function test_Onboard_RegistersAndCreditsInOneCall() public {
        _fundReserves(1_000e6);
        address faucet = makeAddr("relayerFaucet");
        _grantFaucet(faucet);

        vm.expectEmit(true, false, false, false, address(bank));
        emit CommercialBank.ClientRegistered(alice1);
        vm.expectEmit(true, false, false, true, address(bank));
        emit CommercialBank.ClientCredited(alice1, 100e6);
        vm.prank(faucet);
        bank.onboard(alice1, 100e6);

        assertTrue(bank.isClient(alice1));
        assertEq(dep.balanceOf(alice1), 100e6);
    }

    function test_RevertWhen_OnboardCallerLacksFaucetRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bank.FAUCET_ROLE()
            )
        );
        vm.prank(stranger);
        bank.onboard(alice1, 100e6);
    }

    function test_RevertWhen_OnboardAboveCap() public {
        address faucet = makeAddr("relayerFaucet");
        _grantFaucet(faucet);

        uint256 tooMuch = bank.MAX_FAUCET_CREDIT() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(CommercialBank.FaucetAmountTooHigh.selector, tooMuch, bank.MAX_FAUCET_CREDIT())
        );
        vm.prank(faucet);
        bank.onboard(alice1, tooMuch);
    }

    function test_RevertWhen_OnboardAlreadyClient() public {
        _fundReserves(1_000e6);
        address faucet = makeAddr("relayerFaucet");
        _grantFaucet(faucet);

        vm.prank(faucet);
        bank.onboard(alice1, 100e6);

        // One-shot per address: the second onboard reverts, capping on-chain credit.
        vm.expectRevert(abi.encodeWithSelector(CommercialBank.AlreadyClient.selector, alice1));
        vm.prank(faucet);
        bank.onboard(alice1, 100e6);
    }

    /*//////////////////////////////////////////////////////////////
                            FREEZE / UNFREEZE
    //////////////////////////////////////////////////////////////*/

    function test_Freeze_PausesTokenAndEmits() public {
        vm.expectEmit(false, false, false, false);
        emit CommercialBank.BankFrozen();
        vm.prank(operator);
        bank.freeze();
        assertTrue(dep.paused());
    }

    function test_Unfreeze_UnpausesTokenAndEmits() public {
        vm.prank(operator);
        bank.freeze();

        vm.expectEmit(false, false, false, false);
        emit CommercialBank.BankUnfrozen();
        vm.prank(operator);
        bank.unfreeze();
        assertFalse(dep.paused());
    }

    function test_RevertWhen_FreezeWithoutOperatorRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bank.OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        bank.freeze();
    }

    /*//////////////////////////////////////////////////////////////
                        SETTLEMENT ENGINE WIRING
    //////////////////////////////////////////////////////////////*/

    function test_SetSettlementEngine_GrantsRoles() public {
        vm.expectEmit(true, true, false, false);
        emit CommercialBank.SettlementEngineUpdated(address(0), engine);
        vm.prank(operator);
        bank.setSettlementEngine(engine);

        assertEq(bank.settlementEngine(), engine);
        assertTrue(dep.hasRole(dep.MINTER_ROLE(), engine));
        assertTrue(dep.hasRole(dep.BURNER_ROLE(), engine));
        assertTrue(dep.hasRole(dep.SETTLER_ROLE(), engine));
    }

    function test_SetSettlementEngine_RevokesPreviousEngine() public {
        address newEngine = makeAddr("newEngine");
        vm.startPrank(operator);
        bank.setSettlementEngine(engine);
        bank.setSettlementEngine(newEngine);
        vm.stopPrank();

        assertFalse(dep.hasRole(dep.MINTER_ROLE(), engine));
        assertFalse(dep.hasRole(dep.BURNER_ROLE(), engine));
        assertFalse(dep.hasRole(dep.SETTLER_ROLE(), engine));
        assertTrue(dep.hasRole(dep.MINTER_ROLE(), newEngine));
        assertEq(bank.settlementEngine(), newEngine);
    }

    function test_RevertWhen_SetSettlementEngineWithoutOperatorRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bank.OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        bank.setSettlementEngine(engine);
    }

    /*//////////////////////////////////////////////////////////////
                          RESERVES & RATIO
    //////////////////////////////////////////////////////////////*/

    function test_Reserves_TracksWCBDCBalance() public {
        assertEq(bank.reserves(), 0);
        _fundReserves(500_000e6);
        assertEq(bank.reserves(), 500_000e6);
    }

    function test_ReserveRatioBps_ComputesCorrectly() public {
        _fundReserves(500_000e6);
        vm.startPrank(operator);
        bank.registerClient(alice1);
        bank.creditClient(alice1, 4_000_000e6);
        vm.stopPrank();

        // Genesis figures: 500_000 / 4_000_000 = 12.5% = 1_250 bps.
        assertEq(bank.reserveRatioBps(), 1_250);
    }

    function test_ReserveRatioBps_MaxWhenNoDeposits() public view {
        // No deposits -> trivially covered, documented sentinel value.
        assertEq(bank.reserveRatioBps(), type(uint256).max);
    }

    function test_CheckReserveRatio_IsPermissionless() public {
        // Flagging a breach is a pure observation of public state: anyone may call.
        _fundReserves(100e6);
        vm.startPrank(operator);
        bank.registerClient(alice1);
        bank.creditClient(alice1, 900e6);
        vm.stopPrank();

        // Degrade reserves via the central bank (no settlement involved here).
        vm.prank(cbOperator);
        centralBank.burnCBDC(address(bank), 20e6); // 80 / 900 = 8.88% -> 888 bps

        vm.expectEmit(true, false, false, true, address(bank));
        emit CommercialBank.ReserveRatioBreached(address(bank), 888, 1_000);
        vm.prank(stranger);
        bank.checkReserveRatio();
    }

    function test_CheckReserveRatio_SilentAboveThreshold() public {
        _fundReserves(100e6);
        vm.startPrank(operator);
        bank.registerClient(alice1);
        bank.creditClient(alice1, 900e6);
        vm.stopPrank();

        vm.recordLogs();
        vm.prank(stranger);
        bank.checkReserveRatio();
        assertEq(_breachLogCount(), 0);
    }
}
