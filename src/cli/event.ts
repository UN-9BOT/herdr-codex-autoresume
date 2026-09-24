// Event hook entry shim. Herdr invokes this with HERDR_PLUGIN_EVENT set to
// the event name and HERDR_PLUGIN_EVENT_JSON set to the full envelope.
// Args[2] (argv) is the event discriminator; the manifest passes the
// canonical name for clarity and to make the binary self-describing in
// logs.

import { CliHerdrClient } from "../herdr.js";
import { StdLogger } from "../log.js";
import { resolveStateDir } from "./paths.js";
import { handleAgentDetected, handleAgentStatusChanged, type HerdrEventEnvelope } from "../event.js";

const log = new StdLogger();
const eventName = process.argv[2] ?? process.env.HERDR_PLUGIN_EVENT ?? "unknown";
const stateDir = resolveStateDir();

function readEnvelope(): HerdrEventEnvelope {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!raw) return { event: eventName, data: {} };
  try {
    return JSON.parse(raw) as HerdrEventEnvelope;
  } catch {
    log.warn("event_envelope_invalid", { eventName });
    return { event: eventName, data: {} };
  }
}

async function main(): Promise<void> {
  const herdr = new CliHerdrClient();
  const ctx = { event: readEnvelope(), herdr, log, stateDir };
  switch (eventName) {
    case "pane.agent_detected":
    case "agent_detected":
      await handleAgentDetected(ctx);
      break;
    case "pane.agent_status_changed":
    case "agent_status_changed":
      await handleAgentStatusChanged(ctx);
      break;
    default:
      log.warn("event_unknown", { eventName });
  }
}

main().catch((err) => {
  log.error("event_handler_error", { eventName, err: (err as Error).message });
  process.exit(1);
});
