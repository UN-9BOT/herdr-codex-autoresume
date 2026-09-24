import { loadConfig } from "../config.js";
import { type HerdrClient, CliHerdrClient } from "../herdr.js";
import { performResume } from "../resume.js";
import { StateStore } from "../state.js";
import type { Logger, ResumeEntry } from "../types.js";

export interface ResumeNowOptions {
  paneId?: string;
  contextPaneId?: string;
  log?: Logger;
  herdr?: HerdrClient;
  now?: () => number;
}

export interface ResumeNowResult {
  invoked: boolean;
  reason: string;
  paneId?: string;
  resumePaneId?: string;
}

export async function resumeNow(
  stateDir: string,
  opts: ResumeNowOptions,
): Promise<ResumeNowResult> {
  const log = opts.log ?? console as unknown as Logger;
  const config = await loadConfig();
  const herdr = opts.herdr ?? new CliHerdrClient();
  const paneId = opts.paneId ?? opts.contextPaneId;
  if (!paneId) return { invoked: false, reason: "no pane id provided" };
  const store = new StateStore(stateDir);
  const state = await store.load();
  const baseEntry = state.entries[paneId];
  const entry: ResumeEntry = baseEntry
    ? { ...baseEntry, resumeAttempts: baseEntry.resumeAttempts + 1 }
    : {
        paneId,
        agentKind: "codex",
        detectedAtMs: Date.now(),
        status: "waiting",
        resumeAttempts: 1,
      };
  const result = await performResume(entry, { herdr, config, log, now: opts.now ?? Date.now });
  const nextEntries = { ...state.entries };
  nextEntries[paneId] = applyOutcome(entry, result, Date.now());
  await store.save({ version: 1, nextWakeAtMs: state.nextWakeAtMs, entries: nextEntries, modelsByPane: state.modelsByPane, cancelledPaneIds: state.cancelledPaneIds ?? [] });
  if (result.outcome.kind === "resumed") {
    return { invoked: true, reason: result.outcome.kind, paneId, resumePaneId: result.outcome.resumePaneId };
  }
  return { invoked: true, reason: result.outcome.kind, paneId };
}

function applyOutcome(entry: ResumeEntry, result: Awaited<ReturnType<typeof performResume>>, atMs: number): ResumeEntry {
  const merged = { ...entry, ...result.patch };
  switch (result.outcome.kind) {
    case "resumed":
      return {
        ...merged,
        status: "resumed",
        resumedAtMs: result.outcome.resumedAtMs,
        resumePaneId: result.outcome.resumePaneId,
        lastError: undefined,
      };
    case "skipped_dry_run":
      return { ...merged, status: "resumed", resumedAtMs: atMs, lastError: undefined };
    case "already_resumed":
      return { ...merged, status: "resumed", resumedAtMs: atMs, lastError: undefined };
    case "still_limited":
      return {
        ...merged,
        status: "waiting",
        resetAtMs: result.outcome.resetAtMs ?? merged.resetAtMs,
        lastLimitSnippet: result.outcome.snippet ?? merged.lastLimitSnippet,
        lastError: "still_limited",
      };
    case "pane_missing":
      return { ...merged, status: "failed", lastError: "pane_missing", lastAttemptAtMs: atMs };
    case "session_mismatch":
      return { ...merged, status: "failed", lastError: `session_mismatch: ${result.outcome.reason}`, lastAttemptAtMs: atMs };
    case "blocked":
      return { ...merged, status: "waiting", lastError: "agent_blocked_pre_resume", lastAttemptAtMs: atMs };
    case "model_unknown":
      return { ...merged, status: "waiting", lastError: "model_unknown", lastAttemptAtMs: atMs };
    case "spawn_failed":
      return { ...merged, status: "failed", lastError: `spawn_failed: ${result.outcome.reason}`, lastAttemptAtMs: atMs };
    case "dialog_missing":
      return {
        ...merged,
        status: "waiting",
        resumePaneId: result.outcome.resumePaneId,
        lastError: "dialog_missing",
        lastAttemptAtMs: atMs,
      };
  }
}
