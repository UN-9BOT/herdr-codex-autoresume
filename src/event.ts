// Event handlers invoked from the Herdr event hooks. Each handler runs in
// a fresh process; it must finish quickly and cannot own a long-running
// loop. It writes intent files; the long-lived scheduler drains them.

import { detectCodexModel, detectQuotaAvailable, detectUsageLimit, extractSessionIdFromPaneText, isLikelyCodexModel } from "./detector.js";
import { loadConfig } from "./config.js";
import { type HerdrClient, type PaneSnapshot } from "./herdr.js";
import { StateStore } from "./state.js";
import type {
  AgentStatus,
  Intent,
  Logger,
  PluginConfig,
} from "./types.js";

export interface HerdrEventEnvelope {
  event: string;
  data: {
    pane_id?: string;
    workspace_id?: string;
    agent_status?: AgentStatus;
    agent?: string | null;
    released?: boolean;
    final_status?: AgentStatus | null;
    [k: string]: unknown;
  };
}

export interface EventContext {
  event: HerdrEventEnvelope;
  herdr: HerdrClient;
  log: Logger;
  stateDir: string;
}

function readPaneSnapshot(pane: PaneSnapshot | null): PaneSnapshot | null {
  return pane;
}

export async function handleAgentDetected(ctx: EventContext): Promise<void> {
  const { event, herdr, log, stateDir } = ctx;
  const paneId = event.data.pane_id;
  if (!paneId) return;
  const pane = readPaneSnapshot(await herdr.getPane(paneId));
  if (!pane) {
    log.warn("pane_missing_on_detected", { paneId });
    return;
  }
  const config = await loadConfig();
  if (!config.enabled || config.dryRun) return;
  if (!pane.agent || pane.agent.toLowerCase() !== "codex") return;
  const store = new StateStore(stateDir);
  let originalModel: string | undefined;
  try {
    const text = await herdr.readPane(paneId, { source: "recent-unwrapped", lines: Math.max(config.maxReadLines, 240) });
    const detected = detectCodexModel(text);
    originalModel = detected && isLikelyCodexModel(detected) ? detected : config.defaultCodexModel;
  } catch {
    originalModel = config.defaultCodexModel;
  }
  const intent: Intent = {
    kind: "refresh_status",
    paneId: pane.paneId,
    agentStatus: pane.agentStatus,
    atMs: Date.now(),
    hasAgent: true,
    sessionId: pane.agentSessionId,
    originalModel,
  };
  await store.writeIntent(intent);
  log.info("intent_refresh_status", { paneId, agentStatus: pane.agentStatus, originalModel });
}

export async function handleAgentStatusChanged(ctx: EventContext): Promise<void> {
  const { event, herdr, log, stateDir } = ctx;
  const paneId = event.data.pane_id;
  if (!paneId) return;
  const config = await loadConfig();
  if (!config.enabled) return;
  if (config.dryRun) {
    log.debug("dry_run_event", { paneId, agentStatus: event.data.agent_status });
  }
  const pane = await herdr.getPane(paneId);
  if (!pane) {
    log.warn("pane_missing_on_status", { paneId });
    return;
  }
  if (!pane.agent || pane.agent.toLowerCase() !== "codex") return;
  const store = new StateStore(stateDir);

  // Read once; reuse for refresh + limit detection. Use
  // `recent-unwrapped` so the scrollback extends past the visible
  // viewport — the Codex session id in the status line scrolled away
  // after the limit message was emitted.
  let text = "";
  try {
    text = await herdr.readPane(paneId, { source: "recent-unwrapped", lines: Math.max(config.maxReadLines, 240) });
  } catch {
    /* ignore — the refresh intent is still useful */
  }
  const detected = detectCodexModel(text);
  const originalModel = detected && isLikelyCodexModel(detected) ? detected : config.defaultCodexModel;

  // First, refresh the entry's session/status/model state.
  await store.writeIntent({
    kind: "refresh_status",
    paneId,
    agentStatus: pane.agentStatus,
    atMs: Date.now(),
    hasAgent: true,
    sessionId: pane.agentSessionId,
    originalModel,
  });

  if (event.data.agent_status === "working") {
    // Don't try to detect limits when the agent is busy working.
    return;
  }
  // Session id is reported by Herdr when the official Codex integration
  // calls `pane report-agent-session`. But the integration only reports
  // it once per Codex session; when Codex auto-switches to Luna Reserve
  // and then back, the integration may have forgotten the id. Fall back
  // to the on-screen UUID (Codex prints it in the status line).
  const sessionId = pane.agentSessionId ?? extractSessionIdFromPaneText(text);
  const detection = detectUsageLimit(text, Date.now());
  if (detection.detected) {
    await store.writeIntent({
      kind: "detect_limit",
      paneId,
      workspaceId: event.data.workspace_id,
      agentKind: "codex",
      sessionId,
      originalModel,
      detectedAtMs: Date.now(),
      resetAtMs: detection.resetAtMs,
      snippet: detection.rawMatchedText,
    });
    log.info("intent_detect_limit", { paneId, resetAtMs: detection.resetAtMs, originalModel });
  }
  // The pane can also signal "quota is available again, model is back"
  // before the scheduled reset time (e.g. the user upgraded their
  // plan). When that happens, Codex has typically already
  // auto-switched back to the user's original model in the same
  // TUI, so the plugin should send `/goal resume` to the same pane
  // rather than spinning up a fresh `codex resume`.
  const quota = detectQuotaAvailable(text);
  if (quota.detected) {
    await store.writeIntent({
      kind: "schedule_now_inplace",
      paneId,
      atMs: Date.now(),
    });
    log.info("intent_schedule_now_inplace", {
      paneId,
      resumedModel: quota.model,
      originalModel,
    });
  } else {
    // As a fallback, schedule an in-place resume at the recorded
    // resetAtMs — the scheduler will fall through to performResume
    // (new-pane flow) if the limit is still active.
    await store.writeIntent({
      kind: "schedule_now",
      paneId,
      atMs: Date.now(),
    });
  }
}
