# Two-Tier Money Sandbox — Makefile
# Recipes source .env themselves (set -a) so the per-role keys/addresses reach forge/npm.
# CHAIN selects the target for seed/up/fund-check: local (default) | sepolia.
# NB: processes receive it as CHAIN_NAME — foundry binaries auto-load .env and bind a
# CHAIN variable to their --chain flag, so the env name must not collide.

CHAIN ?= local
LOCAL_RPC := http://127.0.0.1:8545
ENV := set -a; [ -f .env ] && . ./.env; set +a
# Call the local tsx binary directly: under MSYS2 `npm run`/`npx` spawn the script in
# an env-stripped shim, so MNEMONIC & co. never reach it. The .bin shim resolves its
# own imports, so the working directory does not matter.
TSX := relayer/node_modules/.bin/tsx

ifeq ($(CHAIN),sepolia)
RPC_FLAG = --rpc-url "$$SEPOLIA_RPC_URL"
else
RPC_FLAG = --rpc-url $(LOCAL_RPC)
endif

.PHONY: build test fmt fmt-check anvil deploy-local deploy-sepolia seed up down fund-check relayer-dev

build:
	cd contracts && forge build

test:
	cd contracts && forge test -vv

fmt:
	cd contracts && forge fmt

fmt-check:
	cd contracts && forge fmt --check

# Local chain on Anvil's default mnemonic — its well-known accounts are exactly the
# public keys/addresses the .env carries, so no mnemonic needs to be passed or stored.
anvil:
	anvil

deploy-local:
	@$(ENV); cd contracts && forge script script/Deploy.s.sol:Deploy --rpc-url $(LOCAL_RPC) --broadcast

deploy-sepolia:
	@$(ENV); cd contracts && forge script script/Deploy.s.sol:Deploy --rpc-url "$$SEPOLIA_RPC_URL" --broadcast

# Idempotent re-seed against deployments/<chain>.json (clients, DEP, sETH top-ups).
seed:
	@$(ENV); cd contracts && forge script script/Seed.s.sol:Seed $(RPC_FLAG) --broadcast

up:
	@$(ENV); CHAIN_NAME=$(CHAIN) docker compose up -d --build

down:
	docker compose down

# Relayer sETH balance alert (exit 1 when under MIN_RELAYER_BALANCE).
fund-check:
	@$(ENV); CHAIN_NAME=$(CHAIN) $(TSX) relayer/scripts/fund-check.ts

# Convenience: relayer on the host with .env loaded (Docker-free dev loop).
relayer-dev:
	@$(ENV); CHAIN_NAME=$(CHAIN) $(TSX) watch relayer/src/index.ts
