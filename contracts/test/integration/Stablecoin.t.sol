// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CentralBank} from "../../src/CentralBank.sol";
import {CommercialBank} from "../../src/CommercialBank.sol";
import {DepositToken} from "../../src/DepositToken.sol";
import {SettlementEngine} from "../../src/SettlementEngine.sol";
import {StableCo} from "../../src/StableCo.sol";
import {StableEUR} from "../../src/StableEUR.sol";
import {WCBDC} from "../../src/WCBDC.sol";

/// @notice End-to-end stablecoin flows on the full genesis state: same-bank and cross-bank
///         mint/redeem (trap #1 — the cross-bank case composes an interbank settlement in
///         the same transaction), the 100% coverage invariant holding throughout, the
///         hard reserve constraint surfacing on redeem, the freeze interaction (sEUR keeps
///         circulating while issuance halts), and both sEUR P2P paths.
contract StablecoinIntegrationTest is Test {
    uint256 internal constant CBDC_PER_BANK = 500_000e6;
    uint256 internal constant DEP_CLIENT_1 = 2_400_000e6; // alice1 / bob1
    uint256 internal constant DEP_CLIENT_2 = 1_600_000e6; // alice2 / bob2

    CentralBank internal centralBank;
    CommercialBank internal bankA;
    CommercialBank internal bankB;
    DepositToken internal depA;
    DepositToken internal depB;
    SettlementEngine internal engine;
    StableCo internal stableCo;
    StableEUR internal seur;
    WCBDC internal wcbdc;

    address internal cbOperator = makeAddr("centralBankOperator");
    address internal opA = makeAddr("bankAOperator");
    address internal opB = makeAddr("bankBOperator");
    address internal scOperator = makeAddr("stableCoOperator");
    address internal relayer = makeAddr("relayer");

    address internal alice1;
    uint256 internal alice1Key;
    address internal alice2;
    uint256 internal alice2Key;
    address internal bob1;
    uint256 internal bob1Key;
    address internal bob2;
    uint256 internal bob2Key;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        (alice1, alice1Key) = makeAddrAndKey("alice1");
        (alice2, alice2Key) = makeAddrAndKey("alice2");
        (bob1, bob1Key) = makeAddrAndKey("bob1");
        (bob2, bob2Key) = makeAddrAndKey("bob2");
        vm.warp(1_000_000);

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
        centralBank.mintCBDC(address(bankA), CBDC_PER_BANK);
        centralBank.mintCBDC(address(bankB), CBDC_PER_BANK);
        centralBank.setSettlementEngine(address(engine));
        vm.stopPrank();

        vm.startPrank(opA);
        bankA.setSettlementEngine(address(engine));
        bankA.registerClient(alice1);
        bankA.registerClient(alice2);
        bankA.creditClient(alice1, DEP_CLIENT_1);
        bankA.creditClient(alice2, DEP_CLIENT_2);
        vm.stopPrank();

        vm.startPrank(opB);
        bankB.setSettlementEngine(address(engine));
        bankB.registerClient(bob1);
        bankB.registerClient(bob2);
        bankB.creditClient(bob1, DEP_CLIENT_1);
        bankB.creditClient(bob2, DEP_CLIENT_2);
        vm.stopPrank();

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

    function _mint(uint256 key, address minter, CommercialBank minterBank, uint256 amount) internal {
        StableCo.MintIntent memory intent = StableCo.MintIntent({
            minter: minter,
            minterBank: address(minterBank),
            amount: amount,
            nonce: stableCo.nonces(minter),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, stableCo.hashMintIntent(intent));
        vm.prank(relayer);
        stableCo.mintFromIntent(intent, abi.encodePacked(r, s, v));
    }

    function _redeem(uint256 key, address redeemer, CommercialBank redeemerBank, uint256 amount) internal {
        StableCo.RedeemIntent memory intent = StableCo.RedeemIntent({
            redeemer: redeemer,
            redeemerBank: address(redeemerBank),
            amount: amount,
            nonce: stableCo.nonces(redeemer),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, stableCo.hashRedeemIntent(intent));
        vm.prank(relayer);
        stableCo.redeemFromIntent(intent, abi.encodePacked(r, s, v));
    }

    /// @dev Builds a redeem intent without submitting (so expectRevert can bind to it).
    function _signedRedeem(uint256 key, address redeemer, CommercialBank redeemerBank, uint256 amount)
        internal
        view
        returns (StableCo.RedeemIntent memory intent, bytes memory sig)
    {
        intent = StableCo.RedeemIntent({
            redeemer: redeemer,
            redeemerBank: address(redeemerBank),
            amount: amount,
            nonce: stableCo.nonces(redeemer),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, stableCo.hashRedeemIntent(intent));
        sig = abi.encodePacked(r, s, v);
    }

    /// @dev Interbank payment via the engine, used to drain a bank's reserves.
    function _pay(uint256 key, address from, CommercialBank fromBank, CommercialBank toBank, address to, uint256 amount)
        internal
    {
        SettlementEngine.PaymentIntent memory intent = SettlementEngine.PaymentIntent({
            from: from,
            fromBank: address(fromBank),
            toBank: address(toBank),
            to: to,
            amount: amount,
            nonce: engine.nonces(from),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, engine.hashIntent(intent));
        vm.prank(relayer);
        engine.executeIntent(intent, abi.encodePacked(r, s, v));
    }

    function _seurDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes("Stable EUR")), keccak256(bytes("1")), block.chainid, address(seur)
            )
        );
    }

    /// @dev Invariant 3 — 100% coverage must hold after every action.
    function _assertFullCoverage() internal view {
        assertLe(seur.totalSupply(), depA.balanceOf(address(stableCo)));
    }

    /*//////////////////////////////////////////////////////////////
                           MINT — SAME BANK
    //////////////////////////////////////////////////////////////*/

    function test_MintSameBank_BookTransferThenIssue() public {
        _mint(alice1Key, alice1, bankA, 100_000e6);

        // Intrabank book transfer of DEP-A from alice1 to the vault; supply untouched.
        assertEq(depA.balanceOf(alice1), DEP_CLIENT_1 - 100_000e6);
        assertEq(stableCo.reserves(), 100_000e6);
        assertEq(depA.totalSupply(), 4_000_000e6);
        assertEq(bankA.reserves(), CBDC_PER_BANK); // no central bank money moved
        assertEq(seur.balanceOf(alice1), 100_000e6);
        _assertFullCoverage();
    }

    /*//////////////////////////////////////////////////////////////
                    MINT — CROSS BANK (trap #1)
    //////////////////////////////////////////////////////////////*/

    function test_MintCrossBank_ComposesInterbankSettlement() public {
        // A Bank B client minting sEUR: burn DEP-B, settle wCBDC B->A, mint DEP-A to the
        // vault, mint sEUR to bob1 — five accounting moves, one transaction (trap #1).
        vm.expectEmit(true, true, false, true, address(stableCo));
        emit StableCo.StableMinted(bob1, address(bankB), 100_000e6);
        _mint(bob1Key, bob1, bankB, 100_000e6);

        assertEq(depB.balanceOf(bob1), DEP_CLIENT_1 - 100_000e6); // DEP-B burned
        assertEq(depB.totalSupply(), 3_900_000e6);
        assertEq(bankB.reserves(), CBDC_PER_BANK - 100_000e6); // wCBDC left B
        assertEq(bankA.reserves(), CBDC_PER_BANK + 100_000e6); // wCBDC arrived at A
        assertEq(stableCo.reserves(), 100_000e6); // DEP-A minted to the vault
        assertEq(depA.totalSupply(), 4_100_000e6);
        assertEq(seur.balanceOf(bob1), 100_000e6);
        assertEq(wcbdc.totalSupply(), 1_000_000e6); // M0 only circulates
        _assertFullCoverage();
    }

    /*//////////////////////////////////////////////////////////////
                              REDEEM
    //////////////////////////////////////////////////////////////*/

    function test_RedeemSameBank_BurnThenBookTransfer() public {
        _mint(alice1Key, alice1, bankA, 100_000e6);
        _redeem(alice1Key, alice1, bankA, 40_000e6);

        assertEq(seur.balanceOf(alice1), 60_000e6);
        assertEq(stableCo.reserves(), 60_000e6);
        assertEq(depA.balanceOf(alice1), DEP_CLIENT_1 - 60_000e6);
        assertEq(bankA.reserves(), CBDC_PER_BANK); // intrabank: no settlement
        _assertFullCoverage();
    }

    function test_RedeemCrossBank_ComposesReverseSettlement() public {
        _mint(bob1Key, bob1, bankB, 100_000e6); // A reserves 600k, B reserves 400k
        _redeem(bob1Key, bob1, bankB, 60_000e6);

        assertEq(seur.balanceOf(bob1), 40_000e6);
        assertEq(stableCo.reserves(), 40_000e6); // DEP-A burned from the vault
        assertEq(depB.balanceOf(bob1), DEP_CLIENT_1 - 100_000e6 + 60_000e6); // DEP-B minted back
        assertEq(bankA.reserves(), CBDC_PER_BANK + 100_000e6 - 60_000e6); // wCBDC A->B
        assertEq(bankB.reserves(), CBDC_PER_BANK - 100_000e6 + 60_000e6);
        _assertFullCoverage();
    }

    function test_RevertWhen_RedeemCrossBank_BankAIlliquid() public {
        _mint(bob1Key, bob1, bankB, 100_000e6); // bank A reserves -> 600_000
        // Drain bank A entirely via an outgoing interbank payment.
        _pay(alice1Key, alice1, bankA, bankB, bob2, 600_000e6);
        assertEq(bankA.reserves(), 0);

        // The reverse settlement (A->B) now hits the hard reserve constraint and reverts —
        // and because the sEUR burn precedes the settlement, the whole tx (burn included)
        // rolls back atomically.
        (StableCo.RedeemIntent memory intent, bytes memory sig) = _signedRedeem(bob1Key, bob1, bankB, 50_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementEngine.InsufficientReserves.selector, address(bankA), 50_000e6, 0)
        );
        vm.prank(relayer);
        stableCo.redeemFromIntent(intent, sig);

        assertEq(seur.balanceOf(bob1), 100_000e6); // unchanged: burn rolled back
    }

    /*//////////////////////////////////////////////////////////////
                          COVERAGE / FREEZE
    //////////////////////////////////////////////////////////////*/

    function test_Coverage_HoldsAcrossMixedFlow() public {
        _mint(alice1Key, alice1, bankA, 200_000e6);
        _assertFullCoverage();
        _mint(bob1Key, bob1, bankB, 150_000e6);
        _assertFullCoverage();
        _redeem(alice1Key, alice1, bankA, 50_000e6);
        _assertFullCoverage();
        _redeem(bob1Key, bob1, bankB, 100_000e6);
        _assertFullCoverage();

        assertEq(stableCo.coverageRatioBps(), 10_000); // exactly 100% throughout
    }

    function test_FreezeBankA_BlocksMintRedeem_ButSEURStillFlows() public {
        _mint(alice1Key, alice1, bankA, 100_000e6); // alice1 now holds 100k sEUR

        vm.prank(opA);
        bankA.freeze(); // DEP-A paused

        // Mint reverts: the DEP-A leg cannot move while frozen (depeg-scenario mechanic).
        StableCo.MintIntent memory mi = StableCo.MintIntent({
            minter: alice1,
            minterBank: address(bankA),
            amount: 1e6,
            nonce: stableCo.nonces(alice1),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alice1Key, stableCo.hashMintIntent(mi));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(relayer);
        stableCo.mintFromIntent(mi, abi.encodePacked(r, s, v));

        // Redeem reverts too.
        (StableCo.RedeemIntent memory ri, bytes memory rsig) = _signedRedeem(alice1Key, alice1, bankA, 1e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(relayer);
        stableCo.redeemFromIntent(ri, rsig);

        // ...yet sEUR keeps moving: the stablecoin is independent of the frozen bank.
        vm.prank(alice1);
        seur.transfer(bob1, 30_000e6);
        assertEq(seur.balanceOf(bob1), 30_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                          sEUR P2P — TWO PATHS
    //////////////////////////////////////////////////////////////*/

    function test_P2P_GaslessEIP3009_RelayerSubmits() public {
        _mint(alice1Key, alice1, bankA, 100_000e6);

        bytes32 nonce = keccak256("p2p-gasless");
        uint256 vb = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(seur.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), alice1, bob1, 25_000e6, uint256(0), vb, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _seurDomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alice1Key, digest);

        // Relayer (not alice1) submits and pays gas.
        vm.prank(relayer);
        seur.transferWithAuthorization(alice1, bob1, 25_000e6, 0, vb, nonce, abi.encodePacked(r, s, v));

        assertEq(seur.balanceOf(bob1), 25_000e6);
        assertEq(seur.balanceOf(alice1), 75_000e6);
    }

    function test_P2P_DirectTransfer_HolderPaysOwnGas() public {
        _mint(alice1Key, alice1, bankA, 100_000e6);

        vm.prank(alice1);
        seur.transfer(bob1, 25_000e6);

        assertEq(seur.balanceOf(bob1), 25_000e6);
        assertEq(seur.balanceOf(alice1), 75_000e6);
    }
}
