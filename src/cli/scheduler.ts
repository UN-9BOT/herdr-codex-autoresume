// Detached scheduler entry. Runs until all entries are terminal or the
// process is signalled to stop. Writes a rolling JSON-lines log under
// `HERDR_PLUGIN_STATE_DIR/scheduler.log`.

import { runScheduler } from "../scheduler.js";
import { FileLogger } from "../log.js";
import { loadConfig } from "../config.js";
import { CliHerdrClient } from "../herdr.js";
import { resolveConfigDir, resolveStateDir } from "./paths.js";

async function main(): Promise<void> {
  const stateDir = resolveStateDir();
  const configDir = resolveConfigDir();
  const config = await loadConfig({ configDir, stateDir });
  const log = new FileLogger({ stateDir });
  const herdr = new CliHerdrClient();
  const ac = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      log.info("scheduler_signal", { signal: sig });
      ac.abort();
    });
  }
  process.on("uncaughtException", (err) => {
    log.error("scheduler_uncaught", { err: err.message, stack: err.stack });
  });
  process.on("unhandledRejection", (err) => {
    log.error("scheduler_unhandled_rejection", { err: String(err) });
  });

  try {
    await runScheduler({ stateDir, config, herdr, log }, ac.signal);
  } catch (err) {
    log.error("scheduler_fatal", { err: (err as Error).message });
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`scheduler fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
