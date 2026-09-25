import { detectCodexModel, detectUsageLimit, isStillLimited } from "./detector.js";
import type { HerdrClient, PaneSnapshot } from "./herdr.js";
import type { Logger, PluginConfig, ResumeEntry } from "./types.js";

export type ResumeOutcome =
  | { kind: "resumed"; paneId: string; resumePaneId: string; resumedAtMs: number }
  | { kind: "still_limited"; paneId: string; resetAtMs?: number; snippet?: string }
  | { kind: "pane_missing"; paneId: string }
  | { kind: "session_mismatch"; paneId: string; reason: string }
  | { kind: "already_resumed"; paneId: string }
  | { kind: "blocked"; paneId: string }
  | { kind: "model_unknown"; paneId: string }
  | { kind: "spawn_failed"; paneId: string; reason: string }
  | { kind: "dialog_missing"; paneId: string; resumePaneId: string }
  | { kind: "skipped_dry_run"; paneId: string };

export interface ResumeDeps {
  herdr: HerdrClient;
  config: PluginConfig;
  log: Logger;
  now: () => number;
}

export interface ResumePreflight {
  pane?: PaneSnapshot;
  outcome?: Exclude<ResumeOutcome, { kind: "resumed" }>;
  model?: string;
  snippet?: string;
}

/**
 * Pre-flight validation. Confirms the original pane still hosts Codex,
 * the Codex session id matches the one we recorded, and the on-screen
 * model is parseable (so the resume command can use it). When the limit
 * message is no longer present, reports `already_resumed` so the
 * scheduler can clear the entry.
 */
export async function preflightResume(
  paneId: string,
  expectedSessionId: string | undefined,
  expectedModel: string | undefined,
  deps: ResumeDeps,
): Promise<ResumePreflight> {
  const pane = await deps.herdr.getPane(paneId);
  if (!pane) {
    deps.log.warn("pane_missing", { paneId });
    return { outcome: { kind: "pane_missing", paneId } };
  }
  if (!pane.agent || pane.agent.toLowerCase() !== "codex") {
    deps.log.warn("session_mismatch", { paneId, reason: "agent is not codex", agent: pane.agent ?? null });
    return { pane, outcome: { kind: "session_mismatch", paneId, reason: "agent is not codex" } };
  }
  // If the entry had no recorded session id, fall back to the pane's
  // current session id; otherwise verify it still matches.
  let resolvedSessionId = pane.agentSessionId;
  if (expectedSessionId && resolvedSessionId && resolvedSessionId !== expectedSessionId) {
    deps.log.warn("session_mismatch", {
      paneId,
      reason: "agent_session_id changed",
      expected: expectedSessionId,
      actual: resolvedSessionId,
    });
    return { pane, outcome: { kind: "session_mismatch", paneId, reason: "agent_session_id changed" } };
  }
  const text = await deps.herdr.readPane(paneId, { source: "recent", lines: deps.config.maxReadLines });
  if (!isStillLimited(text, deps.now())) {
    deps.log.info("already_resumed", { paneId });
    return { pane, outcome: { kind: "already_resumed", paneId } };
  }
  const detection = detectUsageLimit(text, deps.now());
  const model = expectedModel ?? detectCodexModel(text) ?? deps.config.defaultCodexModel ?? null;
  if (!model) {
    deps.log.warn("model_unknown", { paneId });
    return { pane, outcome: { kind: "model_unknown", paneId } };
  }
  return { pane, model, snippet: detection.rawMatchedText };
}

export interface PerformResumeResult {
  outcome: ResumeOutcome;
  /** Updated entry fields the caller should merge. */
  patch: Partial<ResumeEntry>;
}

export type InPlaceResumeOutcome =
  | { kind: "resumed"; paneId: string; resumedAtMs: number }
  | { kind: "pane_missing"; paneId: string }
  | { kind: "session_mismatch"; paneId: string; reason: string }
  | { kind: "still_limited"; paneId: string; snippet?: string }
  | { kind: "not_yet_ready"; paneId: string }
  | { kind: "skipped_dry_run"; paneId: string };

export interface PerformInPlaceResult {
  outcome: InPlaceResumeOutcome;
  patch: Partial<ResumeEntry>;
}

/**
 * In-place resume: when Codex has already auto-switched back to the
 * user's original model in the same pane, sending `/goal resume` to
 * that pane is enough. This is the cheaper path used when
 * `detectQuotaAvailable` fires.
 */
export async function performInPlaceResume(
  entry: ResumeEntry,
  deps: ResumeDeps,
): Promise<PerformInPlaceResult> {
  const pane = await deps.herdr.getPane(entry.paneId);
  if (!pane) {
    deps.log.warn("pane_missing", { paneId: entry.paneId });
    return { outcome: { kind: "pane_missing", paneId: entry.paneId }, patch: {} };
  }
  if (!pane.agent || pane.agent.toLowerCase() !== "codex") {
    deps.log.warn("session_mismatch", { paneId: entry.paneId, reason: "agent is not codex" });
    return {
      outcome: { kind: "session_mismatch", paneId: entry.paneId, reason: "agent is not codex" },
      patch: {},
    };
  }
  if (entry.sessionId && pane.agentSessionId && pane.agentSessionId !== entry.sessionId) {
    deps.log.warn("session_mismatch", {
      paneId: entry.paneId,
      reason: "agent_session_id changed",
      expected: entry.sessionId,
      actual: pane.agentSessionId,
    });
    return {
      outcome: { kind: "session_mismatch", paneId: entry.paneId, reason: "agent_session_id changed" },
      patch: {},
    };
  }
  const text = await deps.herdr.readPane(entry.paneId, {
    source: "recent-unwrapped",
    lines: Math.max(deps.config.maxReadLines, 240),
  });
  const nowMs = deps.now();
  // Require that the pane is no longer limited — otherwise the resume
  // slash command would bounce off the limit dialog again.
  if (isStillLimited(text, nowMs)) {
    const detection = detectUsageLimit(text, nowMs);
    deps.log.info("still_limited_preflight_inplace", { paneId: entry.paneId });
    return {
      outcome: { kind: "still_limited", paneId: entry.paneId, snippet: detection.rawMatchedText },
      patch: {},
    };
  }
  if (deps.config.dryRun) {
    deps.log.info("inplace_dry_run", { paneId: entry.paneId });
    return { outcome: { kind: "skipped_dry_run", paneId: entry.paneId }, patch: {} };
  }
  await deps.herdr.sendText(entry.paneId, deps.config.resumeCommand);
  await deps.herdr.sendKeys(entry.paneId, ["enter"]);
  const observed = await deps.herdr.waitForAgentStatus(
    entry.paneId,
    ["working", "done"],
    Math.max(deps.config.resumeVerificationSeconds * 1000, 5_000),
  );
  if (observed === "working" || observed === "done") {
    deps.log.info("inplace_resume_success", { paneId: entry.paneId, observed });
    return {
      outcome: { kind: "resumed", paneId: entry.paneId, resumedAtMs: nowMs },
      patch: { resumedAtMs: nowMs },
    };
  }
  deps.log.warn("inplace_resume_unverified", { paneId: entry.paneId, observed });
  return { outcome: { kind: "not_yet_ready", paneId: entry.paneId }, patch: {} };
}

/**
 * Execute the resume orchestration:
 *   1. preflight the original pane
 *   2. wait until the recorded reset time has passed
 *   3. spawn a fresh pane (split, default direction: right)
 *   4. launch `codex -m <model> resume <session-id>` in it
 *   5. wait for the "Resume paused goal?" dialog
 *   6. select option 1 and submit Enter
 *   7. confirm the new pane transitions to working
 *
 * The function returns the observed outcome plus a patch of entry
 * fields the caller (scheduler or action) should merge.
 */
export async function performResume(
  entry: ResumeEntry,
  deps: ResumeDeps,
): Promise<PerformResumeResult> {
  const pre = await preflightResume(entry.paneId, entry.sessionId, entry.originalModel, deps);
  if (pre.outcome) {
    if (pre.outcome.kind === "still_limited") {
      return { outcome: pre.outcome, patch: { lastLimitSnippet: pre.outcome.snippet } };
    }
    return { outcome: pre.outcome, patch: {} };
  }
  const model = pre.model ?? entry.originalModel ?? deps.config.defaultCodexModel;
  if (!model) {
    return { outcome: { kind: "model_unknown", paneId: entry.paneId }, patch: {} };
  }
  const sessionId = entry.sessionId ?? pre.pane?.agentSessionId;
  if (!sessionId) {
    return {
      outcome: { kind: "session_mismatch", paneId: entry.paneId, reason: "missing session id" },
      patch: {},
    };
  }

  // Wait until the reset time has actually passed before launching.
  const nowMs = deps.now();
  if (typeof entry.resetAtMs === "number" && entry.resetAtMs > nowMs + 1_000) {
    deps.log.debug("resume_too_early", { paneId: entry.paneId, resetAtMs: entry.resetAtMs, nowMs });
    return {
      outcome: { kind: "still_limited", paneId: entry.paneId, resetAtMs: entry.resetAtMs, snippet: pre.snippet },
      patch: {},
    };
  }

  if (deps.config.dryRun) {
    deps.log.info("skipped_dry_run", { paneId: entry.paneId, model, sessionId });
    return {
      outcome: { kind: "skipped_dry_run", paneId: entry.paneId },
      patch: { originalModel: model },
    };
  }

  // Step 1: spawn a fresh pane next to the original.
  let resumePaneId: string;
  try {
    resumePaneId = await deps.herdr.splitPane({
      sourcePaneId: entry.paneId,
      direction: deps.config.splitDirection,
    });
  } catch (err) {
    deps.log.error("spawn_failed", { paneId: entry.paneId, err: (err as Error).message });
    return {
      outcome: { kind: "spawn_failed", paneId: entry.paneId, reason: (err as Error).message },
      patch: {},
    };
  }

  // Step 2: launch `codex -m <model> resume <sessionId>`. Normalize the
  // model name to lowercase so detection from uppercase Codex status
  // lines still produces a CLI-friendly argument.
  const cmd = ["codex", "-m", model.toLowerCase(), "resume", sessionId];
  try {
    await deps.herdr.runPaneCommand(resumePaneId, cmd);
  } catch (err) {
    deps.log.error("codex_launch_failed", { paneId: entry.paneId, resumePaneId, err: (err as Error).message });
    return {
      outcome: { kind: "spawn_failed", paneId: entry.paneId, reason: `codex launch failed: ${(err as Error).message}` },
      patch: { resumePaneId },
    };
  }

  // Step 3: wait for the "Resume paused goal?" dialog.
  const dialogRegex = "Resume paused goal\\?|Resuming goal|Use your reset to continue|Goal resumed";
  const dialogMatched = await deps.herdr.waitForPaneOutput(
    resumePaneId,
    dialogRegex,
    deps.config.resumeDialogTimeoutSeconds * 1000,
  );
  if (!dialogMatched) {
    deps.log.warn("dialog_missing", { paneId: entry.paneId, resumePaneId });
    return {
      outcome: { kind: "dialog_missing", paneId: entry.paneId, resumePaneId },
      patch: { resumePaneId, originalModel: model },
    };
  }

  // Step 4: select "Resume goal" (option 1) and submit Enter.
  await deps.herdr.sendText(resumePaneId, "1");
  await deps.herdr.sendKeys(resumePaneId, ["enter"]);

  // Step 5: confirm the new pane transitions to working.
  const observed = await deps.herdr.waitForAgentStatus(
    resumePaneId,
    ["working", "idle", "done"],
    deps.config.resumeVerificationSeconds * 1000,
  );
  if (observed === "working" || observed === "idle" || observed === "done") {
    deps.log.info("resume_success", { paneId: entry.paneId, resumePaneId, observed });
    return {
      outcome: { kind: "resumed", paneId: entry.paneId, resumePaneId, resumedAtMs: deps.now() },
      patch: { resumePaneId, originalModel: model, resumedAtMs: deps.now() },
    };
  }

  deps.log.warn("resume_unverified", { paneId: entry.paneId, resumePaneId, observed });
  return {
    outcome: { kind: "dialog_missing", paneId: entry.paneId, resumePaneId },
    patch: { resumePaneId, originalModel: model },
  };
}
