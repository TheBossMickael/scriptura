/**
 * CLI entry for `make fund-check`: prints the relayer's gas balance and exits 1
 * when it sits below the alert threshold (scriptable in CI or cron).
 */
import { createChainContext } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { checkFunds, describeFunds } from "../src/fundCheck.js";

const cfg = loadConfig();
const chain = createChainContext(cfg);

const status = await checkFunds(chain.publicClient, chain.account.address, cfg.minRelayerBalance);
console.log(describeFunds(status));
process.exit(status.funded ? 0 : 1);
