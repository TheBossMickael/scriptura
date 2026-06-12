// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {CentralBank} from "../../src/CentralBank.sol";
import {CommercialBank} from "../../src/CommercialBank.sol";
import {DepositToken} from "../../src/DepositToken.sol";
import {SettlementEngine} from "../../src/SettlementEngine.sol";
import {WCBDC} from "../../src/WCBDC.sol";

contract SettlementEngineTest is Test {
    CentralBank internal centralBank;
    CommercialBank internal bankA;
    CommercialBank internal bankB;
    DepositToken internal depA;
    DepositToken internal depB;
    SettlementEngine internal engine;
    WCBDC internal wcbdc;

    address internal cbOperator = makeAddr("centralBankOperator");
    address internal opA = makeAddr("bankAOperator");
    address internal opB = makeAddr("bankBOperator");
    address internal alice1 = makeAddr("alice1");
    address internal alice2 = makeAddr("alice2");
    address internal bob1 = makeAddr("bob1");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant BREACH_TOPIC = keccak256("ReserveRatioBreached(address,uint256,uint256)");
    bytes32 internal constant SETTLED_TOPIC = keccak256("Settled(address,address,address,address,uint256)");

    function setUp() public {
        centralBank = new CentralBank(cbOperator);
        wcbdc = centralBank.wcbdc();
        bankA = new CommercialBank(opA, centralBank, "Bank A Deposit", "DEP-A");
        bankB = new CommercialBank(opB, centralBank, "Bank B Deposit", "DEP-B");
        depA = bankA.depositToken();
        depB = bankB.depositToken();
        engine = new SettlementEngine(centralBank);

        vm.startPrank(cbOperator);
        centralBank.registerBank(address(bankA));
        centralBank.registerBank(address(bankB));
        centralBank.mintCBDC(address(bankA), 1_000e6);
        centralBank.mintCBDC(address(bankB), 1_000e6);
        centralBank.setSettlementEngine(address(engine));
        vm.stopPrank();

        // Both banks at 12.5% ratio (1_000 reserves / 8_000 deposits), threshold 10%.
        vm.startPrank(opA);
        bankA.setSettlementEngine(address(engine));
        bankA.registerClient(alice1);
        bankA.registerClient(alice2);
        bankA.creditClient(alice1, 5_000e6);
        bankA.creditClient(alice2, 3_000e6);
        vm.stopPrank();

        vm.startPrank(opB);
        bankB.setSettlementEngine(address(engine));
        bankB.registerClient(bob1);
        bankB.creditClient(bob1, 8_000e6);
        vm.stopPrank();
    }

    /// @dev Counts entries with the given event topic among recorded logs.
    function _logCount(bytes32 topic) internal returns (uint256 count) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic) count++;
        }
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_WiresCentralBankAndWCBDC() public view {
        assertEq(address(engine.centralBank()), address(centralBank));
        assertEq(address(engine.wcbdc()), address(wcbdc));
        assertTrue(wcbdc.hasRole(wcbdc.SETTLER_ROLE(), address(engine)));
    }

    /*//////////////////////////////////////////////////////////////
                               VALIDATION
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_ZeroAmount() public {
        vm.expectRevert(SettlementEngine.ZeroAmount.selector);
        vm.prank(alice1);
        engine.settle(address(bankA), address(bankB), bob1, 0);
    }

    function test_RevertWhen_FromBankNotRegistered() public {
        address fakeBank = makeAddr("fakeBank");
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotRegisteredBank.selector, fakeBank));
        vm.prank(alice1);
        engine.settle(fakeBank, address(bankB), bob1, 1e6);
    }

    function test_RevertWhen_ToBankNotRegistered() public {
        address fakeBank = makeAddr("fakeBank");
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotRegisteredBank.selector, fakeBank));
        vm.prank(alice1);
        engine.settle(address(bankA), fakeBank, bob1, 1e6);
    }

    function test_RevertWhen_PayerNotClient() public {
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotBankClient.selector, address(bankA), stranger));
        vm.prank(stranger);
        engine.settle(address(bankA), address(bankB), bob1, 1e6);
    }

    function test_RevertWhen_PayeeNotClient() public {
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotBankClient.selector, address(bankB), stranger));
        vm.prank(alice1);
        engine.settle(address(bankA), address(bankB), stranger, 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                               INTRABANK
    //////////////////////////////////////////////////////////////*/

    function test_Intrabank_TransfersDepositsWithoutWCBDC() public {
        vm.expectEmit(true, true, true, true, address(engine));
        emit SettlementEngine.IntrabankTransfer(address(bankA), alice1, alice2, 700e6);
        vm.prank(alice1);
        engine.settle(address(bankA), address(bankA), alice2, 700e6);

        assertEq(depA.balanceOf(alice1), 4_300e6);
        assertEq(depA.balanceOf(alice2), 3_700e6);
        assertEq(depA.totalSupply(), 8_000e6); // book transfer: M1 supply untouched
        assertEq(wcbdc.balanceOf(address(bankA)), 1_000e6); // no central bank money moved
        assertEq(wcbdc.balanceOf(address(bankB)), 1_000e6);
    }

    function test_Intrabank_EmitsNoSettledEvent() public {
        vm.recordLogs();
        vm.prank(alice1);
        engine.settle(address(bankA), address(bankA), alice2, 100e6);
        assertEq(_logCount(SETTLED_TOPIC), 0);
    }

    function test_RevertWhen_IntrabankInsufficientBalance() public {
        // No reserve pre-check on the intrabank path: only the payer's DEP balance binds.
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice1, 5_000e6, 6_000e6)
        );
        vm.prank(alice1);
        engine.settle(address(bankA), address(bankA), alice2, 6_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERBANK
    //////////////////////////////////////////////////////////////*/

    function test_Interbank_SettlesAtomically() public {
        vm.expectEmit(true, true, true, true, address(engine));
        emit SettlementEngine.Settled(alice1, address(bankA), address(bankB), bob1, 100e6);
        vm.prank(alice1);
        engine.settle(address(bankA), address(bankB), bob1, 100e6);

        // INVARIANT 7: burn(DEP-A) == wCBDC moved == mint(DEP-B), all in one tx.
        assertEq(depA.balanceOf(alice1), 4_900e6);
        assertEq(depA.totalSupply(), 7_900e6);
        assertEq(wcbdc.balanceOf(address(bankA)), 900e6);
        assertEq(wcbdc.balanceOf(address(bankB)), 1_100e6);
        assertEq(depB.balanceOf(bob1), 8_100e6);
        assertEq(depB.totalSupply(), 8_100e6);
        assertEq(wcbdc.totalSupply(), 2_000e6); // M0 circulates, never created
    }

    function test_Interbank_NoBreachAboveThreshold() public {
        vm.recordLogs();
        vm.prank(alice1);
        engine.settle(address(bankA), address(bankB), bob1, 100e6); // 900/7_900 = 11.39%
        assertEq(_logCount(BREACH_TOPIC), 0);
    }

    function test_Interbank_EmitsBreachAndStillSettles() public {
        // 700 reserves / 7_700 deposits = 9.09% < 10% threshold. The breach is emitted by
        // the paying BANK contract (factored check), and the payment still settles: the
        // ratio is a soft, monitored constraint, never a per-transaction gate (trap #4).
        vm.expectEmit(true, false, false, true, address(bankA));
        emit CommercialBank.ReserveRatioBreached(address(bankA), 909, 1_000);
        vm.prank(alice1);
        engine.settle(address(bankA), address(bankB), bob1, 300e6);

        assertEq(depB.balanceOf(bob1), 8_300e6); // settled despite the breach
        assertEq(wcbdc.balanceOf(address(bankA)), 700e6);
    }

    function test_RevertWhen_InsufficientReserves() public {
        // alice1 holds 5_000 DEP-A but bank A only holds 1_000 wCBDC: the hard physical
        // constraint binds (ILLIQUID state) even though the client balance suffices.
        vm.expectRevert(
            abi.encodeWithSelector(SettlementEngine.InsufficientReserves.selector, address(bankA), 2_000e6, 1_000e6)
        );
        vm.prank(alice1);
        engine.settle(address(bankA), address(bankB), bob1, 2_000e6);
    }
}
