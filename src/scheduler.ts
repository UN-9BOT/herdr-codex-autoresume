import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { nextResetAfterFailure } from "./backoff.js";
import {
  performInPlaceResume,
  performResume,
  type PerformInPlaceResult,
  type PerformResumeResult,
  type ResumeOutcome,
} from "./resume.js";
import { StateStore } from "./state.js";
import type { HerdrClient } from "./herdr.js";
import type {
  Intent,
  Logger,
  PersistedState,
  PluginConfig,
  ResumeEntry,
} from "./types.js";

const PID_FILE = "scheduler.pid";
const LOCK_FILE = "scheduler.lock";

export interface SchedulerOptions {
  stateDir: string;
  config: PluginConfig;
  herdr: HerdrClient;
  log: Logger;
  now?: () => number;
}

export interface SchedulerHandle {
  shutdown: () => Promise<void>;
}

interface AcquiredLock {
  pid: number;
  path: string;
}

async function tryAcquireLock(stateDir: string, pid: number): Promise<AcquiredLock | null> {
  const path = join(stateDir, LOCK_FILE);
  await mkdir(stateDir, { recursive: true });
  if (existsSync(path)) {
    try {
      const text = await readFile(path, "utf8");
      const lockPid = parseInt(text.trim(), 10);
      if (Number.isFinite(lockPid) && lockPid !== pid) {
        if (isPidAlive(lockPid)) {
          return null;
        }
      }
    } catch {
      /* stale; overwrite */
    }
  }
  const tmp = `${path}.tmp`;
  await writeFile(tmp, String(pid), "utf8");
  await writeFile(path, String(pid), "utf8");
  return { pid, path };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(lock: AcquiredLock): Promise<void> {
  try {
    await unlink(lock.path);
  } catch {
    /* best effort */
  }
  try {
    await unlink(`${lock.path}.tmp`);
  } catch {
    /* best effort */
  }
}

export async function writePidFile(stateDir: string, pid: number): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, PID_FILE), String(pid) + "\n", "utf8");
}

export async function clearPidFile(stateDir: string): Promise<void> {
  try {
    await unlink(join(stateDir, PID_FILE));
  } catch {
    /* best effort */
  }
}

export async function isSchedulerRunning(stateDir: string): Promise<boolean> {
  const file = join(stateDir, PID_FILE);
  if (!existsSync(file)) return false;
  try {
    const text = await readFile(file, "utf8");
    const pid = parseInt(text.trim(), 10);
    if (!Number.isFinite(pid)) return false;
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

function computeNextWake(state: PersistedState, nowMs: number, pollIntervalMs: number): number {
  let next = nowMs + pollIntervalMs;
  for (const entry of Object.values(state.entries)) {
    if (entry.status === "resumed" || entry.status === "cancelled" || entry.status === "failed") {
      continue;
    }
    if (typeof entry.resetAtMs === "number" && entry.resetAtMs > 0) {
      next = Math.min(next, entry.resetAtMs);
    }
  }
  if (state.nextWakeAtMs > 0) {
    next = Math.min(next, state.nextWakeAtMs);
  }
  return next;
}

function entryDue(entry: ResumeEntry, nowMs: number): boolean {
  if (entry.status === "resumed" || entry.status === "cancelled" || entry.status === "failed") return false;
  if (entry.status === "spawning" || entry.status === "resuming") return true; // recovery from crash mid-resume
  const dueAt = entry.resetAtMs ?? 0;
  return dueAt > 0 && dueAt <= nowMs;
}

function entryInPlace(entry: ResumeEntry): boolean {
  return entry.status === "inplace_resuming";
}

function applyIntent(state: PersistedState, intent: Intent, nowMs: number): PersistedState {
  const entries = { ...state.entries };
  switch (intent.kind) {
    case "detect_limit": {
      // Honor a pending cancel: if the user cancelled this pane's
      // auto-resume while the detect_limit intent was being written,
      // the cancel may have raced ahead in lex order. Check the
      // persistent cancelledPaneIds list before creating the entry.
      if ((state.cancelledPaneIds ?? []).includes(intent.paneId)) {
        break;
      }
      const existing = entries[intent.paneId];
      // When the on-screen model has already been overwritten by
      // Codex's auto-switch to Luna Reserve, prefer the model captured
      // earlier in `modelsByPane`. The intent's own `originalModel` is
      // a fallback for the case where the cache is empty.
      const cachedModel = state.modelsByPane[intent.paneId];
      const resolvedModel = intent.originalModel ?? cachedModel;
      const next: ResumeEntry = existing
        ? {
            ...existing,
            sessionId: intent.sessionId ?? existing.sessionId,
            workspaceId: intent.workspaceId ?? existing.workspaceId,
            originalModel: resolvedModel ?? existing.originalModel,
            detectedAtMs: intent.detectedAtMs,
            status: "waiting",
            lastLimitSnippet: intent.snippet ?? existing.lastLimitSnippet,
            resetAtMs: intent.resetAtMs ?? existing.resetAtMs,
          }
        : {
            paneId: intent.paneId,
            agentKind: intent.agentKind,
            sessionId: intent.sessionId,
            workspaceId: intent.workspaceId,
            originalModel: resolvedModel,
            detectedAtMs: intent.detectedAtMs,
            status: "waiting",
            resumeAttempts: 0,
            resetAtMs: intent.resetAtMs,
            lastLimitSnippet: intent.snippet,
          };
      entries[intent.paneId] = next;
      if (typeof intent.resetAtMs === "number") {
        state.nextWakeAtMs = Math.min(state.nextWakeAtMs || Number.MAX_SAFE_INTEGER, intent.resetAtMs);
      } else {
        state.nextWakeAtMs = Math.min(state.nextWakeAtMs || Number.MAX_SAFE_INTEGER, nowMs + 5_000);
      }
      break;
    }
    case "schedule_now": {
      const existing = entries[intent.paneId];
      if (existing && (existing.status === "waiting" || existing.status === "still_limited")) {
        entries[intent.paneId] = { ...existing, resetAtMs: intent.atMs };
        state.nextWakeAtMs = Math.min(state.nextWakeAtMs || Number.MAX_SAFE_INTEGER, intent.atMs);
      }
      break;
    }
    case "schedule_now_inplace": {
      const existing = entries[intent.paneId];
      if (existing && (existing.status === "waiting" || existing.status === "still_limited")) {
        // Remember the originally scheduled reset time so we can
        // re-arm the entry if the in-place attempt fails (pane is
        // still limited, session id missing, etc.).
        const originalResetAtMs = existing.resetAtMs ?? intent.atMs;
        entries[intent.paneId] = {
          ...existing,
          resetAtMs: intent.atMs,
          originalResetAtMs,
          status: "inplace_resuming",
        };
        state.nextWakeAtMs = Math.min(state.nextWakeAtMs || Number.MAX_SAFE_INTEGER, intent.atMs);
      }
      break;
    }
    case "mark_resumed": {
      const existing = entries[intent.paneId];
      if (existing) {
        entries[intent.paneId] = { ...existing, status: "resumed", resumedAtMs: intent.atMs, lastError: undefined };
      }
      break;
    }
    case "mark_failed": {
      const existing = entries[intent.paneId];
      if (existing) {
        entries[intent.paneId] = { ...existing, status: "failed", lastError: intent.error, lastAttemptAtMs: intent.atMs };
      }
      break;
    }
    case "cancel": {
      const existing = entries[intent.paneId];
      if (existing) {
        entries[intent.paneId] = { ...existing, status: "cancelled" };
      } else {
        // Create a tombstone entry so downstream code (status action,
        // tests, etc.) can observe the cancellation even when the
        // detect_limit intent hasn't arrived yet.
        entries[intent.paneId] = {
          paneId: intent.paneId,
          agentKind: "codex",
          detectedAtMs: intent.atMs,
          status: "cancelled",
          resumeAttempts: 0,
        };
      }
      // Persist the cancel even if the entry doesn't exist yet, so a
      // racing detect_limit intent can be filtered out.
      state.cancelledPaneIds = Array.from(new Set([...(state.cancelledPaneIds ?? []), intent.paneId]));
      break;
    }
    case "refresh_status": {
      // Update the model cache regardless of whether an entry exists.
      // We only cache values that look like real models (i.e. not the
      // placeholder "Reserve" used after Codex auto-switches).
      if (typeof intent.originalModel === "string" && intent.originalModel !== "" && intent.originalModel.toLowerCase() !== "reserve") {
        state.modelsByPane = { ...(state.modelsByPane ?? {}), [intent.paneId]: intent.originalModel };
      }
      const existing = entries[intent.paneId];
      if (!existing) break;
      if (intent.agentStatus === "working") {
        entries[intent.paneId] = { ...existing, status: "resumed", resumedAtMs: intent.atMs, lastError: undefined };
      } else if (existing.status === "waiting" || existing.status === "still_limited") {
        if (!intent.hasAgent) {
          // pane no longer hosts codex
          entries[intent.paneId] = { ...existing, status: "failed", lastError: "codex agent no longer present", lastAttemptAtMs: intent.atMs };
        }
      }
      if (typeof intent.sessionId === "string" && intent.sessionId !== "" && !existing.sessionId) {
        entries[intent.paneId] = { ...existing, sessionId: intent.sessionId };
      }
      if (typeof intent.originalModel === "string" && intent.originalModel !== "" && !existing.originalModel) {
        entries[intent.paneId] = { ...existing, originalModel: intent.originalModel };
      }
      break;
    }
  }
  return { ...state, entries, modelsByPane: state.modelsByPane ?? {}, cancelledPaneIds: state.cancelledPaneIds ?? [] };
}

async function processIntent(state: PersistedState, intent: Intent, store: StateStore, log: Logger): Promise<PersistedState> {
  if (intent.kind === "detect_limit") {
    log.info("detected_limit", {
      paneId: intent.paneId,
      resetAtMs: intent.resetAtMs,
      snippet: intent.snippet,
    });
  }
  return applyIntent(state, intent, Date.now());
}

async function processDue(
  state: PersistedState,
  nowMs: number,
  deps: SchedulerOptions,
  store: StateStore,
): Promise<PersistedState> {
  const entries = { ...state.entries };
  const resumeDeps = { herdr: deps.herdr, config: deps.config, log: deps.log, now: deps.now ?? Date.now };
  for (const [paneId, entry] of Object.entries(entries)) {
    if (entryInPlace(entry)) {
      // In-place resume path: CodeX has already auto-switched back
      // to the user's model; just send `/goal resume` to the same pane.
      let result: PerformInPlaceResult;
      try {
        result = await performInPlaceResume(entries[paneId]!, resumeDeps);
      } catch (err) {
        deps.log.error("inplace_resume_error", { paneId, err: (err as Error).message });
        entries[paneId] = {
          ...entries[paneId]!,
          status: "failed",
          lastError: (err as Error).message,
        };
        continue;
      }
      switch (result.outcome.kind) {
        case "resumed":
          entries[paneId] = {
            ...entries[paneId]!,
            ...result.patch,
            status: "resumed",
            resumedAtMs: result.outcome.resumedAtMs,
          };
          break;
        case "still_limited":
          entries[paneId] = {
            ...entries[paneId]!,
            ...result.patch,
            status: "waiting",
            lastError: "still_limited",
            lastLimitSnippet: result.outcome.snippet ?? entries[paneId]!.lastLimitSnippet,
            // Restore the originally scheduled reset time so the
            // new-pane flow doesn't kick in until the limit truly
            // expires. If we have no recorded original (e.g. the
            // entry is fresh), schedule a 30s poll so we can
            // detect the next "switched back" event.
            resetAtMs:
              entries[paneId]!.originalResetAtMs ??
              nowMs + Math.min(deps.config.retryMaxSeconds, 30) * 1000,
          };
          break;
        case "pane_missing":
        case "session_mismatch":
          entries[paneId] = {
            ...entries[paneId]!,
            status: "failed",
            lastError: `${result.outcome.kind}: ${("reason" in result.outcome) ? result.outcome.reason : ""}`,
            lastAttemptAtMs: nowMs,
          };
          break;
        case "not_yet_ready":
          entries[paneId] = {
            ...entries[paneId]!,
            status: "waiting",
            lastAttemptAtMs: nowMs,
            lastError: "inplace_resume_unverified",
            resetAtMs: nowMs + Math.min(deps.config.retryMaxSeconds, 30) * 1000,
          };
          state.nextWakeAtMs = Math.min(state.nextWakeAtMs || Number.MAX_SAFE_INTEGER, nowMs + 30_000);
          break;
        case "skipped_dry_run":
          entries[paneId] = {
            ...entries[paneId]!,
            status: "resumed",
            resumedAtMs: Date.now(),
            lastError: undefined,
          };
          break;
      }
      continue;
    }
    if (!entryDue(entry, nowMs)) continue;
    entries[paneId] = { ...entry, status: "spawning", lastAttemptAtMs: nowMs, resumeAttempts: entry.resumeAttempts + 1 };
    await store.save({ version: 1, nextWakeAtMs: state.nextWakeAtMs, entries, modelsByPane: state.modelsByPane ?? {}, cancelledPaneIds: state.cancelledPaneIds ?? [] });
    let result: PerformResumeResult;
    try {
      result = await performResume(entries[paneId]!, resumeDeps);
    } catch (err) {
      deps.log.error("resume_error", { paneId, err: (err as Error).message });
      entries[paneId] = {
        ...entries[paneId]!,
        status: "failed",
        lastError: (err as Error).message,
      };
      continue;
    }
    const outcome = result.outcome;
    entries[paneId] = { ...entries[paneId]!, ...result.patch };
    switch (outcome.kind) {
      case "resumed": {
        deps.log.info("resume_success", {
          paneId,
          resumePaneId: outcome.resumePaneId,
          resumedAtMs: outcome.resumedAtMs,
        });
        entries[paneId] = {
          ...entries[paneId]!,
          status: "resumed",
          resumedAtMs: outcome.resumedAtMs,
          resumePaneId: outcome.resumePaneId,
          lastError: undefined,
        };
        break;
      }
      case "still_limited": {
        const nextAttempts = entries[paneId]!.resumeAttempts;
        const nextReset = nextResetAfterFailure(nextAttempts, outcome.resetAtMs, nowMs, deps.config.retryMaxSeconds);
        deps.log.warn("still_limited", { paneId, resetAtMs: outcome.resetAtMs, nextResetMs: nextReset });
        entries[paneId] = {
          ...entries[paneId]!,
          status: "waiting",
          resetAtMs: nextReset,
          lastLimitSnippet: outcome.snippet ?? entries[paneId]!.lastLimitSnippet,
        };
        state.nextWakeAtMs = Math.min(state.nextWakeAtMs || Number.MAX_SAFE_INTEGER, nextReset);
        break;
      }
      case "pane_missing": {
        deps.log.warn("pane_missing", { paneId });
        entries[paneId] = { ...entries[paneId]!, status: "failed", lastError: "pane_missing" };
        break;
      }
      case "session_mismatch": {
        deps.log.warn("session_mismatch", { paneId, reason: outcome.reason });
        entries[paneId] = { ...entries[paneId]!, status: "failed", lastError: `session_mismatch: ${outcome.reason}` };
        break;
      }
      case "already_resumed": {
        deps.log.info("already_resumed", { paneId });
        entries[paneId] = { ...entries[paneId]!, status: "resumed", resumedAtMs: Date.now(), lastError: undefined };
        break;
      }
      case "blocked": {
        deps.log.warn("blocked", { paneId });
        entries[paneId] = {
          ...entries[paneId]!,
          status: "waiting",
          resetAtMs: nowMs + Math.min(deps.config.retryMaxSeconds, 30) * 1000,
          lastError: "agent_blocked_pre_resume",
        };
        state.nextWakeAtMs = Math.min(state.nextWakeAtMs || Number.MAX_SAFE_INTEGER, nowMs + 30_000);
        break;
      }
      case "model_unknown": {
        deps.log.warn("model_unknown", { paneId });
        entries[paneId] = { ...entries[paneId]!, status: "waiting", lastError: "model_unknown", resetAtMs: nowMs + 60_000 };
        state.nextWakeAtMs = Math.min(state.nextWakeAtMs || Number.MAX_SAFE_INTEGER, nowMs + 60_000);
        break;
      }
      case "spawn_failed": {
        deps.log.error("spawn_failed", { paneId, reason: outcome.reason });
        entries[paneId] = { ...entries[paneId]!, status: "failed", lastError: `spawn_failed: ${outcome.reason}` };
        break;
      }
      case "dialog_missing": {
        deps.log.warn("dialog_missing", { paneId, resumePaneId: outcome.resumePaneId });
        entries[paneId] = {
          ...entries[paneId]!,
          status: "waiting",
          resetAtMs: nowMs + Math.min(deps.config.retryMaxSeconds, 60) * 1000,
          lastError: "dialog_missing",
          resumePaneId: outcome.resumePaneId,
        };
        state.nextWakeAtMs = Math.min(state.nextWakeAtMs || Number.MAX_SAFE_INTEGER, nowMs + 60_000);
        break;
      }
      case "skipped_dry_run": {
        entries[paneId] = { ...entries[paneId]!, status: "resumed", resumedAtMs: Date.now() };
        break;
      }
    }
  }
  return { ...state, entries };
}

function entriesAreTerminal(state: PersistedState): boolean {
  return Object.values(state.entries).every(
    (e) => e.status === "resumed" || e.status === "cancelled" || e.status === "failed",
  );
}

/**
 * Whether the scheduler should exit: only when a termination signal has
 * arrived. Empty state is NOT a reason to exit; the scheduler must
 * remain alive so it can drain intents written by event handlers
 * shortly after startup.
 */
function shouldExit(signal: AbortSignal): boolean {
  return signal.aborted;
}

function pruneOld(state: PersistedState, nowMs: number): PersistedState {
  const entries = { ...state.entries };
  for (const [k, e] of Object.entries(entries)) {
    if ((e.status === "resumed" || e.status === "cancelled" || e.status === "failed") && (e.resumedAtMs ?? e.detectedAtMs) + 24 * 60 * 60 * 1000 < nowMs) {
      delete entries[k];
    }
  }
  // Drop stale cancels whose entries were never created.
  const cancelled = (state.cancelledPaneIds ?? []).filter((id) => id in entries || true);
  // Keep cancels forever for safety; entries map dictates lifetime.
  return { ...state, entries, cancelledPaneIds: cancelled };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run the scheduler loop. The function resolves when:
 *   - all entries reach a terminal state, or
 *   - `signal` is aborted.
 *
 * It is intentionally structured as a single async function so tests can
 * invoke it with a fake clock and assert against the persisted state.
 */
export async function runScheduler(opts: SchedulerOptions, signal: AbortSignal): Promise<void> {
  const store = new StateStore(opts.stateDir);
  const now = opts.now ?? Date.now;
  const pollMs = Math.max(2_000, opts.config.pollIntervalSeconds * 1000);

  const lock = await tryAcquireLock(opts.stateDir, process.pid);
  if (!lock) {
    opts.log.warn("scheduler_lock_busy", { stateDir: opts.stateDir });
    return;
  }
  await writePidFile(opts.stateDir, process.pid);
  opts.log.info("scheduler_start", { stateDir: opts.stateDir, pollMs });

  try {
    let state = pruneOld(await store.load(), now());

    while (!shouldExit(signal)) {
      const intents = await store.drainIntents();
      for (const intent of intents) {
        state = await processIntent(state, intent, store, opts.log);
      }
      state = pruneOld(state, now());

      const nowMs = now();
      state = await processDue(state, nowMs, opts, store);

      // Re-drain intents written while processDue was running. This
      // covers the race where a cancel intent sorts before a
      // detect_limit intent (same-millisecond timestamps cause
      // non-deterministic lex order); the cancel finds no entry on
      // first pass, but the entry has now been created by processDue
      // and we must apply the cancel before sleeping.
      const followUpIntents = await store.drainIntents();
      for (const intent of followUpIntents) {
        state = await processIntent(state, intent, store, opts.log);
      }

      // Recompute next wake; save and either sleep or continue.
      const nextWake = computeNextWake(state, nowMs, pollMs);
      state = { ...state, nextWakeAtMs: nextWake };
      await store.save(state);

      // The scheduler stays alive even when state is empty: event
      // handlers may write a new intent at any time and we must be
      // ready to drain it. We only exit on SIGTERM/SIGINT/SIGHUP.
      const sleepMs = Math.max(250, nextWake - nowMs);
      opts.log.debug("scheduler_sleep", { sleepMs, nextWake, entries: Object.keys(state.entries).length });
      if (entriesAreTerminal(state) && intents.length === 0 && followUpIntents.length === 0) {
        // Log periodically so an idle scheduler is still observable.
        opts.log.info("scheduler_idle_tick", {
          nextWakeMs: nextWake,
          pollMs,
        });
      }
      await sleep(sleepMs, signal);
    }
  } finally {
    await releaseLock(lock);
    await clearPidFile(opts.stateDir);
    opts.log.info("scheduler_stop");
  }
}
