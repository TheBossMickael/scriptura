# Two-Tier Money — Makefile
# Recipes source .env themselves (set -a) so the per-role keys/addresses reach forge/npm.
# CHAIN selects the target for seed/fund-check: local (default) | sepolia.
# NB: processes receive it as CHAIN_NAME — foundry binaries auto-load .env and bind a
# CHAIN variable to their --chain flag, so the env name must not collide.

CHAIN ?= local
LOCAL_RPC := http://127.0.0.1:8545
ENV := set -a; [ -f .env ] && . ./.env; set +a
# Call the local tsx binary directly: under MSYS2 `npm run`/`npx` spawn the script in
# an env-stripped shim, so the per-role keys & co. never reach it. The .bin shim resolves its
# own imports, so the working directory does not matter.
TSX := relayer/node_modules/.bin/tsx

ifeq ($(CHAIN),sepolia)
RPC_FLAG = --rpc-url "$$SEPOLIA_RPC_URL"
else
RPC_FLAG = --rpc-url $(LOCAL_RPC)
endif

.PHONY: build test fmt fmt-check anvil deploy-local deploy-sepolia seed fund-check relayer-dev indexer-dev front-dev front-build

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

# One-shot testnet deploy + seed; --verify uses foundry.toml [etherscan] (ETHERSCAN_API_KEY).
deploy-sepolia:
	@$(ENV); cd contracts && forge script script/Deploy.s.sol:Deploy --rpc-url "$$SEPOLIA_RPC_URL" --broadcast --verify

# Idempotent re-seed against deployments/<chain>.json (clients, DEP, sETH top-ups).
seed:
	@$(ENV); cd contracts && forge script script/Seed.s.sol:Seed $(RPC_FLAG) --broadcast

# Relayer sETH balance alert (exit 1 when under MIN_RELAYER_BALANCE).
fund-check:
	@$(ENV); CHAIN_NAME=$(CHAIN) $(TSX) relayer/scripts/fund-check.ts

# Relayer on the host with .env loaded (CHAIN=local|sepolia).
relayer-dev:
	@$(ENV); CHAIN_NAME=$(CHAIN) $(TSX) watch relayer/src/index.ts

# Ponder indexer on the host (reads deployments/<chain>.json, serves its API on :42069).
# Calls the local ponder binary directly (npm-run shims strip env under MSYS2).
indexer-dev:
	@$(ENV); cd indexer && CHAIN_NAME=$(CHAIN) node_modules/.bin/ponder dev

# Vite dev server for the frontend (http://localhost:5173). For local dev the defaults
# (relayer :3001, indexer :42069) need no env; override via VITE_* in .env if needed.
front-dev:
	cd frontend && npm run dev

# Production build of the frontend (static assets in frontend/dist).
front-build:
	cd frontend && npm run build
