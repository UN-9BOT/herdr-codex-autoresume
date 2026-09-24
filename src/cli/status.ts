import { resolveConfigDir, resolveStateDir } from "./paths.js";
import { loadConfig } from "../config.js";
import { buildStatusReport, formatStatus } from "../actions/status.js";

async function main(): Promise<void> {
  const stateDir = resolveStateDir();
  const configDir = resolveConfigDir();
  await loadConfig({ configDir, stateDir });
  const paneFromCtx = readContextPaneId();
  const jsonFlag = process.argv.includes("--json");
  const report = await buildStatusReport(stateDir, { paneId: paneFromCtx ?? undefined, json: jsonFlag });
  if (jsonFlag) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatStatus(report));
}

function readContextPaneId(): string | null {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const id = (parsed as Record<string, unknown>).focused_pane_id;
      if (typeof id === "string") return id;
    }
  } catch {
    /* ignore */
  }
  return null;
}

main().catch((err) => {
  process.stderr.write(`status failed: ${(err as Error).message}\n`);
  process.exit(1);
});
