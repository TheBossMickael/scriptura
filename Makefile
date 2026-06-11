# Two-Tier Money Sandbox — Makefile
# Phase 1: minimal targets. Completed in Phase 3 with anvil, deploy-local,
# deploy-sepolia, seed, up, down, fund-check (see CLAUDE.md "Commands").

.PHONY: build test fmt fmt-check

build:
	cd contracts && forge build

test:
	cd contracts && forge test -vv

fmt:
	cd contracts && forge fmt

fmt-check:
	cd contracts && forge fmt --check
