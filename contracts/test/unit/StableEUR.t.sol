// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {StableEUR} from "../../src/StableEUR.sol";

/// @notice Unit tests for the sEUR token: 6 decimals, role-gated mint/burn (no EOA minter,
///         trap #2), the two P2P paths (plain transfer + EIP-3009), and the full EIP-3009
///         surface (transfer/receive/cancel, window, replay, wrong signer).
contract StableEURTest is Test {
    StableEUR internal seur;

    // `issuer` stands in for the StableCo vault (sole admin/minter/burner).
    address internal issuer = makeAddr("issuer");
    address internal relayer = makeAddr("relayer");
    address internal alice;
    uint256 internal aliceKey;
    address internal bob;
    uint256 internal bobKey;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        vm.warp(1_000_000); // a known wall-clock for the EIP-3009 validity windows

        seur = new StableEUR(issuer);
        vm.prank(issuer);
        seur.mint(alice, 1_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                              EIP-712 HELPERS
    //////////////////////////////////////////////////////////////*/

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes("Stable EUR")), keccak256(bytes("1")), block.chainid, address(seur)
            )
        );
    }

    function _sign(uint256 key, bytes32 structHash) internal pure returns (bytes memory) {
        // structHash already includes the domain via the caller; here we only sign.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, structHash);
        return abi.encodePacked(r, s, v);
    }

    function _signAuth(
        uint256 key,
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        return _sign(key, digest);
    }

    /*//////////////////////////////////////////////////////////////
                            ROLES / METADATA
    //////////////////////////////////////////////////////////////*/

    function test_Metadata() public view {
        assertEq(seur.decimals(), 6);
        assertEq(seur.symbol(), "sEUR");
        assertEq(seur.name(), "Stable EUR");
    }

    function test_Constructor_GrantsAllRolesToIssuer() public view {
        assertTrue(seur.hasRole(seur.DEFAULT_ADMIN_ROLE(), issuer));
        assertTrue(seur.hasRole(seur.MINTER_ROLE(), issuer));
        assertTrue(seur.hasRole(seur.BURNER_ROLE(), issuer));
    }

    function test_RevertWhen_NonMinterMints() public {
        // Trap #2: no EOA can mint. Even a random caller is rejected.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), seur.MINTER_ROLE()
            )
        );
        seur.mint(bob, 1e6);
    }

    function test_RevertWhen_NonBurnerBurns() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), seur.BURNER_ROLE()
            )
        );
        seur.burn(alice, 1e6);
    }

    function test_MintAndBurn_ByIssuer() public {
        vm.prank(issuer);
        seur.mint(bob, 500e6);
        assertEq(seur.balanceOf(bob), 500e6);

        vm.prank(issuer);
        seur.burn(bob, 200e6);
        assertEq(seur.balanceOf(bob), 300e6);
    }

    /*//////////////////////////////////////////////////////////////
                          P2P PATH #2 — DIRECT
    //////////////////////////////////////////////////////////////*/

    function test_DirectTransfer_Works() public {
        // Permissionless: alice pays her own gas and moves sEUR with no infra in the loop.
        vm.prank(alice);
        seur.transfer(bob, 100e6);
        assertEq(seur.balanceOf(alice), 900e6);
        assertEq(seur.balanceOf(bob), 100e6);
    }

    /*//////////////////////////////////////////////////////////////
                    P2P PATH #1 — EIP-3009 (GASLESS)
    //////////////////////////////////////////////////////////////*/

    function test_TransferWithAuthorization_RelayerSubmits() public {
        bytes32 nonce = keccak256("nonce-1");
        bytes memory sig = _signAuth(
            aliceKey,
            seur.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            alice,
            bob,
            100e6,
            0,
            block.timestamp + 1 hours,
            nonce
        );

        vm.expectEmit(true, true, false, false, address(seur));
        emit StableEUR.AuthorizationUsed(alice, nonce);
        vm.prank(relayer); // submitter != payer: alice spends no gas
        seur.transferWithAuthorization(alice, bob, 100e6, 0, block.timestamp + 1 hours, nonce, sig);

        assertEq(seur.balanceOf(bob), 100e6);
        assertTrue(seur.authorizationState(alice, nonce));
    }

    function test_RevertWhen_AuthorizationReplayed() public {
        bytes32 nonce = keccak256("nonce-2");
        uint256 vb = block.timestamp + 1 hours;
        bytes memory sig =
            _signAuth(aliceKey, seur.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, 100e6, 0, vb, nonce);
        seur.transferWithAuthorization(alice, bob, 100e6, 0, vb, nonce, sig);

        vm.expectRevert(abi.encodeWithSelector(StableEUR.AuthorizationAlreadyUsed.selector, alice, nonce));
        seur.transferWithAuthorization(alice, bob, 100e6, 0, vb, nonce, sig);
    }

    function test_RevertWhen_AuthorizationNotYetValid() public {
        bytes32 nonce = keccak256("nonce-3");
        uint256 va = block.timestamp + 100;
        bytes memory sig = _signAuth(
            aliceKey,
            seur.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            alice,
            bob,
            100e6,
            va,
            block.timestamp + 1 hours,
            nonce
        );

        vm.expectRevert(abi.encodeWithSelector(StableEUR.AuthorizationNotYetValid.selector, va));
        seur.transferWithAuthorization(alice, bob, 100e6, va, block.timestamp + 1 hours, nonce, sig);
    }

    function test_RevertWhen_AuthorizationExpired() public {
        bytes32 nonce = keccak256("nonce-4");
        uint256 vb = block.timestamp - 1; // already past
        bytes memory sig =
            _signAuth(aliceKey, seur.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, 100e6, 0, vb, nonce);

        vm.expectRevert(abi.encodeWithSelector(StableEUR.AuthorizationExpired.selector, vb));
        seur.transferWithAuthorization(alice, bob, 100e6, 0, vb, nonce, sig);
    }

    function test_RevertWhen_AuthorizationWrongSigner() public {
        bytes32 nonce = keccak256("nonce-5");
        uint256 vb = block.timestamp + 1 hours;
        // bob signs an authorization that debits alice: recovery yields bob, not alice.
        bytes memory sig =
            _signAuth(bobKey, seur.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, 100e6, 0, vb, nonce);

        vm.expectRevert(abi.encodeWithSelector(StableEUR.InvalidAuthorizationSigner.selector, bob, alice));
        seur.transferWithAuthorization(alice, bob, 100e6, 0, vb, nonce, sig);
    }

    function test_ReceiveWithAuthorization_OnlyPayeeMayCall() public {
        bytes32 nonce = keccak256("nonce-6");
        uint256 vb = block.timestamp + 1 hours;
        bytes memory sig =
            _signAuth(aliceKey, seur.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, 100e6, 0, vb, nonce);

        // A front-runner (the relayer) cannot submit a receive authorization.
        vm.expectRevert(abi.encodeWithSelector(StableEUR.CallerNotPayee.selector, relayer, bob));
        vm.prank(relayer);
        seur.receiveWithAuthorization(alice, bob, 100e6, 0, vb, nonce, sig);

        // The intended payee can.
        vm.prank(bob);
        seur.receiveWithAuthorization(alice, bob, 100e6, 0, vb, nonce, sig);
        assertEq(seur.balanceOf(bob), 100e6);
    }

    function test_CancelAuthorization_BlocksLaterUse() public {
        bytes32 nonce = keccak256("nonce-7");
        uint256 vb = block.timestamp + 1 hours;
        bytes32 cancelStruct = keccak256(abi.encode(seur.CANCEL_AUTHORIZATION_TYPEHASH(), alice, nonce));
        bytes32 cancelDigest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), cancelStruct));
        bytes memory cancelSig = _sign(aliceKey, cancelDigest);

        vm.expectEmit(true, true, false, false, address(seur));
        emit StableEUR.AuthorizationCanceled(alice, nonce);
        seur.cancelAuthorization(alice, nonce, cancelSig);
        assertTrue(seur.authorizationState(alice, nonce));

        bytes memory sig =
            _signAuth(aliceKey, seur.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, 100e6, 0, vb, nonce);
        vm.expectRevert(abi.encodeWithSelector(StableEUR.AuthorizationAlreadyUsed.selector, alice, nonce));
        seur.transferWithAuthorization(alice, bob, 100e6, 0, vb, nonce, sig);
    }
}
