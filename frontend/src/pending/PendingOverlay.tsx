// Deprecated: the full-screen blocking overlay was replaced by per-section <TxStatus> feedback
// (loading → tx hash + Etherscan link). The lock is now enforced by disabling all action
// buttons while `usePending().isBusy` is true. Kept as an empty module to avoid stale imports.
export {};
