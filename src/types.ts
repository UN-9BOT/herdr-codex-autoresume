// Domain types for the herdr-codex-autoresume plugin.
//
// These types intentionally avoid depending on any Herdr runtime — they
// describe the plugin's own state, configuration, and decisions. They are
// the single source of truth used by tests, the scheduler, event handlers,
// and the user-facing actions.

export type AgentKind = "codex";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type EntryStatus =
  | "waiting"
  | "due"
  | "spawning"
  | "resuming"
  | "inplace_resuming"
  | "resumed"
  | "still_limited"
  | "failed"
  | "cancelled";

/**
 * State stored on disk for a single pending auto-resume. Keyed by pane id.
 *
 * The pane id is the only stable identity that survives Herdr restarts in
 * plugin v1; the optional Codex session id (provided by Herdr as
 * `agent_session.value`) is recorded for cross-checks but is not the
 * primary key, because Herdr can hand a freshly-restored Codex pane the
 * same public pane id while the underlying session id matches a previous
 * one.
 */
export interface ResumeEntry {
  paneId: string;
  workspaceId?: string;
  agentKind: AgentKind;
  /** Codex conversation session id, when known. */
  sessionId?: string;
  /**
   * Original Codex model the user was running (e.g. "gpt-5.6-sol"). When
   * Codex hits a usage limit it auto-switches the open TUI to a reserved
   * Luna model, so the plugin must relaunch the session in a fresh pane
   * with the original model.
   */
  originalModel?: string;
  detectedAtMs: number;
  resetAtMs?: number;
  /** Snippet of the matched usage-limit text, capped at 200 chars. */
  lastLimitSnippet?: string;
  status: EntryStatus;
  resumeAttempts: number;
  lastAttemptAtMs?: number;
  lastError?: string;
  /** Set true once the resume command was actually accepted by Codex. */
  resumedAtMs?: number;
  /** Pane id of the freshly spawned pane that runs `codex resume ...`. */
  resumePaneId?: string;
  /** Workspace id where the resume pane was spawned (post-move). */
  resumeWorkspaceId?: string;
}

/**
 * Persisted plugin state. Versioned so future migrations can be explicit.
 *
 * `nextWakeAtMs` is a hint used by the scheduler; the scheduler still
 * bounds its sleep with `pollIntervalMs` so the file is advisory.
 */
export interface PersistedState {
  version: 1;
  nextWakeAtMs: number;
  entries: Record<string, ResumeEntry>;
  /**
   * Most-recently-seen Codex model per pane, keyed by pane id. Populated
   * whenever a codex pane reports its model (typically on every event
   * hook invocation while the user is running their preferred model).
   * The plugin uses this cache when a usage limit is later detected on
   * a pane whose TUI has already auto-switched to "Luna Reserve" — at
   * that point the on-screen model is no longer the user's original.
   */
  modelsByPane: Record<string, string>;
  /**
   * Pane ids whose pending auto-resume must be cancelled. Persisted
   * across iterations so a cancel intent that races ahead of a
   * detect_limit intent (same-millisecond timestamps cause
   * non-deterministic lex order) still takes effect when the entry
   * finally arrives.
   */
  cancelledPaneIds: string[];
}

export const CURRENT_STATE_VERSION = 1 as const;

/**
 * Intent written by short-lived event handlers; drained by the scheduler.
 * Decouples event handlers (which spawn in fresh processes) from the
 * state file (which only the scheduler should write).
 */
export type Intent =
  | {
      kind: "detect_limit";
      paneId: string;
      workspaceId?: string;
      agentKind: AgentKind;
      sessionId?: string;
      originalModel?: string;
      detectedAtMs: number;
      resetAtMs?: number;
      snippet?: string;
    }
  | {
      kind: "mark_resumed";
      paneId: string;
      atMs: number;
    }
  | {
      kind: "mark_failed";
      paneId: string;
      atMs: number;
      error: string;
    }
  | {
      kind: "refresh_status";
      paneId: string;
      agentStatus: AgentStatus;
      atMs: number;
      hasAgent: boolean;
      sessionId?: string;
      originalModel?: string;
    }
  | {
      kind: "cancel";
      paneId: string;
      atMs: number;
    }
  | {
      kind: "schedule_now";
      paneId: string;
      atMs: number;
    }
  | {
      /**
       * Same as `schedule_now` plus an instruction that the resume
       * should happen in-place: send `/goal resume` to the original
       * pane (which already auto-switched back to the user's model)
       * instead of spawning a fresh `codex resume` pane.
       */
      kind: "schedule_now_inplace";
      paneId: string;
      atMs: number;
    };

export interface PluginConfig {
  enabled: boolean;
  /** Slash command sent to Codex as the resume action. */
  resumeCommand: string;
  /**
   * Default Codex model to use when the resume pane is launched and the
   * entry has not yet captured an `originalModel`. When unset, the plugin
   * requires the original model to be parsed from the source pane.
   */
  defaultCodexModel?: string;
  /**
   * Direction of the split used to spawn the resume pane.
   * "right" | "down" — defaults to "right".
   */
  splitDirection: "right" | "down";
  /** Max recent terminal rows read when scanning for usage-limit markers. */
  maxReadLines: number;
  /** Cap of the exponential-backoff schedule (seconds). */
  retryMaxSeconds: number;
  /** How long to wait for the new codex pane to launch before declaring failure. */
  resumePaneLaunchTimeoutSeconds: number;
  /** How long to wait for the "Resume paused goal?" dialog after launch. */
  resumeDialogTimeoutSeconds: number;
  /** How long to wait after answering the dialog for the goal to resume. */
  resumeVerificationSeconds: number;
  /** Scheduler polling interval; also bounds wake latency. */
  pollIntervalSeconds: number;
  /** When true, the plugin refuses to write intents / act. */
  dryRun: boolean;
  /** Test-only override: a path to a fixture file used as fake pane text. */
  simulationFixturePath?: string;
  /**
   * Test-only override: a fixture path whose content is parsed for a
   * simulated "post-resume" pane snapshot. When set, the resume flow
   * reads this fixture instead of the live pane after sending the
   * resume command.
   */
  simulationPostResumeFixturePath?: string;
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  resumeCommand: "/goal resume",
  splitDirection: "right",
  maxReadLines: 120,
  retryMaxSeconds: 300,
  resumePaneLaunchTimeoutSeconds: 30,
  resumeDialogTimeoutSeconds: 30,
  resumeVerificationSeconds: 15,
  pollIntervalSeconds: 10,
  dryRun: false,
};

export function defaultConfig(): PluginConfig {
  return { ...DEFAULT_CONFIG };
}

export interface LoggerFields {
  [k: string]: unknown;
}

export interface Logger {
  info(event: string, fields?: LoggerFields): void;
  warn(event: string, fields?: LoggerFields): void;
  error(event: string, fields?: LoggerFields): void;
  debug(event: string, fields?: LoggerFields): void;
}
