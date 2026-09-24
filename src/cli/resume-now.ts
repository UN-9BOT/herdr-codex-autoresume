import { resolveConfigDir, resolveStateDir } from "./paths.js";
import { loadConfig } from "../config.js";
import { resumeNow } from "../actions/resume-now.js";

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

async function main(): Promise<void> {
  const stateDir = resolveStateDir();
  const configDir = resolveConfigDir();
  await loadConfig({ configDir, stateDir });
  const args = process.argv.slice(2);
  const paneArg = args.find((a) => a.startsWith("--pane="))?.split("=", 2)[1] ?? args[0];
  const result = await resumeNow(stateDir, {
    paneId: typeof paneArg === "string" && paneArg !== "" ? paneArg : undefined,
    contextPaneId: readContextPaneId() ?? undefined,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch((err) => {
  process.stderr.write(`resume-now failed: ${(err as Error).message}\n`);
  process.exit(1);
});
