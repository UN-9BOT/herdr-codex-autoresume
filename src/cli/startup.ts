// Entry shim for the `[[startup]]` hook. Herdr calls this once after
// session restore; it must exit promptly. We spawn a detached scheduler
// process and record its pid, then return.

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isSchedulerRunning, writePidFile } from "../scheduler.js";
import { StdLogger } from "../log.js";

const log = new StdLogger();

function die(message: string): never {
  log.error("startup_error", { message });
  process.exit(1);
}

async function main(): Promise<void> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT;
  if (!stateDir) die("HERDR_PLUGIN_STATE_DIR not set");
  if (!pluginRoot) die("HERDR_PLUGIN_ROOT not set");

  await mkdir(stateDir, { recursive: true });

  if (await isSchedulerRunning(stateDir)) {
    log.info("scheduler_already_running", { stateDir });
    return;
  }

  const entry = resolve(join(pluginRoot, "dist", "cli", "scheduler.js"));
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  if (!child.pid) {
    die("failed to spawn scheduler child");
  }
  await writePidFile(stateDir, child.pid);
  log.info("scheduler_spawned", { pid: child.pid, entry });

  // Give the child a moment to claim the lock; if it crashes immediately,
  // surface that via the pid liveness check on next startup.
  setTimeout(() => {
    try {
      process.kill(child.pid!, 0);
    } catch {
      log.warn("scheduler_exited_immediately", { pid: child.pid });
    }
  }, 1_000).unref();
}

const here = dirname(fileURLToPath(import.meta.url));
log.info("startup_loaded", { here });

main().catch((err) => {
  log.error("startup_unhandled", { err: (err as Error).message });
  process.exit(1);
});
