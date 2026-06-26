// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CentralBank} from "../../src/CentralBank.sol";
import {CommercialBank} from "../../src/CommercialBank.sol";
import {DepositToken} from "../../src/DepositToken.sol";
import {SettlementEngine} from "../../src/SettlementEngine.sol";
import {StableCo} from "../../src/StableCo.sol";
import {StableEUR} from "../../src/StableEUR.sol";

/// @notice Unit tests for the StableCo vault's own surface: constructor wiring, the
///         operator's pause-only power, the absence of any EOA mint path (trap #2),
///         intent verification (deadline, signer, sequential nonce), pause gating, and the
///         reserve/coverage views. The deep same/cross-bank mint-redeem matrix lives in
///         the integration suite.
contract StableCoTest is Test {
    CentralBank internal centralBank;
    CommercialBank internal bankA;
    CommercialBank internal bankB;
    DepositToken internal depA;
    SettlementEngine internal engine;
    StableCo internal stableCo;
    StableEUR internal seur;

    address internal cbOperator = makeAddr("centralBankOperator");
    address internal opA = makeAddr("bankAOperator");
    address internal opB = makeAddr("bankBOperator");
    address internal scOperator = makeAddr("stableCoOperator");
    address internal relayer = makeAddr("relayer");

    address internal alice1;
    uint256 internal alice1Key;
    address internal bob1;
    uint256 internal bob1Key;
    address internal stranger;
    uint256 internal strangerKey;

    function setUp() public {
        (alice1, alice1Key) = makeAddrAndKey("alice1");
        (bob1, bob1Key) = makeAddrAndKey("bob1");
        (stranger, strangerKey) = makeAddrAndKey("stranger");

        centralBank = new CentralBank(cbOperator);
        bankA = new CommercialBank(opA, centralBank, "Bank A Deposit", "DEP-A");
        bankB = new CommercialBank(opB, centralBank, "Bank B Deposit", "DEP-B");
        depA = bankA.depositToken();
        engine = new SettlementEngine(centralBank);

        vm.startPrank(cbOperator);
        centralBank.registerBank(address(bankA));
        centralBank.registerBank(address(bankB));
        centralBank.mintCBDC(address(bankA), 1_000e6);
        centralBank.mintCBDC(address(bankB), 1_000e6);
        centralBank.setSettlementEngine(address(engine));
        vm.stopPrank();

        vm.startPrank(opA);
        bankA.setSettlementEngine(address(engine));
        bankA.registerClient(alice1);
        bankA.creditClient(alice1, 5_000e6);
        vm.stopPrank();

        vm.startPrank(opB);
        bankB.setSettlementEngine(address(engine));
        bankB.registerClient(bob1);
        bankB.creditClient(bob1, 8_000e6);
        vm.stopPrank();

        // Stablecoin wiring: StableCo deployed by its operator, plugged into the engine by
        // the central bank, registered as a Bank A client.
        vm.prank(scOperator);
        stableCo = new StableCo(engine, bankA, scOperator);
        seur = stableCo.seur();
        vm.prank(cbOperator);
        engine.setStableCo(address(stableCo));
        vm.prank(opA);
        bankA.registerClient(address(stableCo));
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _mintIntent(address minter, address minterBank, uint256 amount)
        internal
        view
        returns (StableCo.MintIntent memory)
    {
        return StableCo.MintIntent({
            minter: minter,
            minterBank: minterBank,
            amount: amount,
            nonce: stableCo.nonces(minter),
            deadline: block.timestamp + 1 hours
        });
    }

    function _signMint(uint256 key, StableCo.MintIntent memory intent) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, stableCo.hashMintIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    function _redeemIntent(address redeemer, address redeemerBank, uint256 amount)
        internal
        view
        returns (StableCo.RedeemIntent memory)
    {
        return StableCo.RedeemIntent({
            redeemer: redeemer,
            redeemerBank: redeemerBank,
            amount: amount,
            nonce: stableCo.nonces(redeemer),
            deadline: block.timestamp + 1 hours
        });
    }

    function _signRedeem(uint256 key, StableCo.RedeemIntent memory intent) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, stableCo.hashRedeemIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_WiresEngineBankAndDeploysSEUR() public view {
        assertEq(address(stableCo.engine()), address(engine));
        assertEq(address(stableCo.bankA()), address(bankA));
        assertEq(address(stableCo.depA()), address(depA));
        assertTrue(address(seur) != address(0));
        // StableCo is the sole admin/minter/burner of the sEUR it deployed.
        assertTrue(seur.hasRole(seur.DEFAULT_ADMIN_ROLE(), address(stableCo)));
        assertTrue(seur.hasRole(seur.MINTER_ROLE(), address(stableCo)));
        assertTrue(seur.hasRole(seur.BURNER_ROLE(), address(stableCo)));
    }

    function test_Constructor_GrantsOperatorRole() public view {
        assertTrue(stableCo.hasRole(stableCo.OPERATOR_ROLE(), scOperator));
        assertTrue(stableCo.hasRole(stableCo.DEFAULT_ADMIN_ROLE(), scOperator));
    }

    function test_NoEOAMintsSEUR() public view {
        // Trap #2: supply is endogenous. The operator (and any EOA) is powerless to mint.
        assertFalse(seur.hasRole(seur.MINTER_ROLE(), scOperator));
        assertFalse(seur.hasRole(seur.MINTER_ROLE(), cbOperator));
        assertFalse(seur.hasRole(seur.BURNER_ROLE(), scOperator));
    }

    /*//////////////////////////////////////////////////////////////
                            OPERATOR POWERS
    //////////////////////////////////////////////////////////////*/

    function test_Pause_OnlyOperator() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, stableCo.OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        stableCo.pause();

        vm.prank(scOperator);
        stableCo.pause();
        assertTrue(stableCo.paused());

        vm.prank(scOperator);
        stableCo.unpause();
        assertFalse(stableCo.paused());
    }

    function test_RevertWhen_MintWhilePaused_ButSEURStillCirculates() public {
        // Seed alice with sEUR via a normal mint, then pause issuance.
        bytes memory sig = _signMint(alice1Key, _mintIntent(alice1, address(bankA), 1_000e6));
        stableCo.mintFromIntent(_mintIntent(alice1, address(bankA), 1_000e6), sig);

        vm.prank(scOperator);
        stableCo.pause();

        // Mint and redeem are suspended...
        StableCo.MintIntent memory mi = _mintIntent(alice1, address(bankA), 100e6);
        bytes memory miSig = _signMint(alice1Key, mi);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        stableCo.mintFromIntent(mi, miSig);

        // ...but the sEUR already issued keeps circulating (desintermediation).
        vm.prank(alice1);
        seur.transfer(bob1, 250e6);
        assertEq(seur.balanceOf(bob1), 250e6);
    }

    /*//////////////////////////////////////////////////////////////
                          INTENT VERIFICATION
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_ZeroAmount() public {
        StableCo.MintIntent memory mi = _mintIntent(alice1, address(bankA), 0);
        bytes memory sig = _signMint(alice1Key, mi);
        vm.expectRevert(StableCo.ZeroAmount.selector);
        stableCo.mintFromIntent(mi, sig);
    }

    function test_RevertWhen_MintExpired() public {
        StableCo.MintIntent memory mi = _mintIntent(alice1, address(bankA), 100e6);
        mi.deadline = block.timestamp - 1;
        bytes memory sig = _signMint(alice1Key, mi);
        vm.expectRevert(abi.encodeWithSelector(StableCo.IntentExpired.selector, mi.deadline));
        stableCo.mintFromIntent(mi, sig);
    }

    function test_RevertWhen_MintWrongSigner() public {
        // stranger signs an intent minting for alice1: recovery yields stranger.
        StableCo.MintIntent memory mi = _mintIntent(alice1, address(bankA), 100e6);
        bytes memory sig = _signMint(strangerKey, mi);
        vm.expectRevert(abi.encodeWithSelector(StableCo.InvalidIntentSigner.selector, stranger, alice1));
        stableCo.mintFromIntent(mi, sig);
    }

    function test_RevertWhen_MintNonceReplayed() public {
        StableCo.MintIntent memory mi = _mintIntent(alice1, address(bankA), 100e6);
        bytes memory sig = _signMint(alice1Key, mi);
        stableCo.mintFromIntent(mi, sig);

        vm.expectRevert(abi.encodeWithSelector(Nonces.InvalidAccountNonce.selector, alice1, 1));
        stableCo.mintFromIntent(mi, sig);
    }

    function test_MintAndRedeem_AdvanceSequentialNonce() public {
        bytes memory sig = _signMint(alice1Key, _mintIntent(alice1, address(bankA), 1_000e6));
        stableCo.mintFromIntent(_mintIntent(alice1, address(bankA), 1_000e6), sig);
        assertEq(stableCo.nonces(alice1), 1);

        bytes memory rsig = _signRedeem(alice1Key, _redeemIntent(alice1, address(bankA), 400e6));
        vm.prank(relayer);
        stableCo.redeemFromIntent(_redeemIntent(alice1, address(bankA), 400e6), rsig);
        assertEq(stableCo.nonces(alice1), 2);
        assertEq(seur.balanceOf(alice1), 600e6);
    }

    function test_RevertWhen_RedeemWrongSigner() public {
        StableCo.RedeemIntent memory ri = _redeemIntent(alice1, address(bankA), 100e6);
        bytes memory sig = _signRedeem(strangerKey, ri);
        vm.expectRevert(abi.encodeWithSelector(StableCo.InvalidIntentSigner.selector, stranger, alice1));
        stableCo.redeemFromIntent(ri, sig);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function test_Coverage_FullAtAllTimes() public {
        assertEq(stableCo.reserves(), 0);
        assertEq(stableCo.coverageRatioBps(), type(uint256).max); // no supply yet

        bytes memory sig = _signMint(alice1Key, _mintIntent(alice1, address(bankA), 1_000e6));
        stableCo.mintFromIntent(_mintIntent(alice1, address(bankA), 1_000e6), sig);

        assertEq(stableCo.reserves(), 1_000e6);
        assertEq(seur.totalSupply(), 1_000e6);
        assertEq(stableCo.coverageRatioBps(), 10_000); // exactly 100%
    }
}
