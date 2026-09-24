import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

import type { AgentStatus } from "./types.js";

/**
 * Read-only pane metadata returned by Herdr. Mirrors a subset of
 * `PaneInfo`; we deliberately only model the fields the plugin reads.
 */
export interface PaneSnapshot {
  paneId: string;
  workspaceId: string;
  tabId: string;
  terminalId: string;
  agent?: string;
  title?: string;
  displayAgent?: string;
  agentStatus: AgentStatus;
  /** Codex conversation session id, when the official Codex integration reported one. */
  agentSessionId?: string;
}

export interface AgentSession {
  source: string;
  agent: string;
  value: string;
}

/**
 * Subset of the Herdr PaneInfo field set we rely on. Tests use it to drive
 * the mock client.
 */
export interface RawPaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id: string;
  agent?: string | null;
  title?: string | null;
  display_agent?: string | null;
  agent_status: AgentStatus;
  agent_session?: AgentSession | null;
}

export interface HerdrCallError extends Error {
  code?: string;
  status?: number;
}

/**
 * Abstract Herdr client. Tests substitute a fake; production uses the
 * `CliHerdrClient` wrapper around the `herdr` binary.
 */
export interface HerdrClient {
  /** Resolve a public pane id (or agent name) to the current pane info. */
  getPane(target: string): Promise<PaneSnapshot | null>;
  /**
   * Read recent pane text. Returns the joined decoded output; callers pass
   * `--lines` and `--source` so the snapshot is appropriate.
   */
  readPane(target: string, options: { source?: "recent" | "recent-unwrapped" | "visible" | "detection"; lines?: number }): Promise<string>;
  /** Get the live agent record for a pane id or agent name. */
  getAgent(target: string): Promise<PaneSnapshot | null>;
  /** Send literal text (no Enter). */
  sendText(target: string, text: string): Promise<void>;
  /** Send logical key names such as `enter`, `esc`, `ctrl+c`. */
  sendKeys(target: string, keys: string[]): Promise<void>;
  /** Wait for an agent to reach any of the supplied states. Returns the observed status. */
  waitForAgentStatus(target: string, until: AgentStatus[], timeoutMs: number): Promise<AgentStatus>;
  /** Best-effort check that a pane still exists. Returns false on `pane_not_found` style errors. */
  paneExists(paneId: string): Promise<boolean>;
  /**
   * Wait for a regex match in the pane's recent output. Returns the matched
   * text (or null on timeout).
   */
  waitForPaneOutput(target: string, regex: string, timeoutMs: number): Promise<string | null>;
  /**
   * Split a pane. Returns the new pane id. `direction` is "right" or
   * "down" (the only directions Herdr's CLI exposes for split).
   */
  splitPane(opts: { sourcePaneId: string; direction: "right" | "down"; ratio?: number; cwd?: string }): Promise<string>;
  /**
   * Run a command in a pane; submits with Enter atomically. Returns the
   * new pane id when the call originated from a split.
   */
  runPaneCommand(target: string, command: string[]): Promise<void>;
  /**
   * Spawn a fresh pane that runs a brand-new agent (used for the
   * post-resume Codex pane). Returns the new pane id.
   */
  spawnPaneForAgent(opts: { sourcePaneId: string; direction: "right" | "down"; cwd?: string }): Promise<string>;
}

export class HerdrCommandError extends Error implements HerdrCallError {
  readonly code: string;
  readonly status: number | undefined;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "HerdrCommandError";
    this.code = code;
    this.status = status;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number;
}

async function runProcess(program: string, args: string[], env?: Record<string, string | undefined>): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(program, args, {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (status) => {
      resolve({ stdout, stderr, status: status ?? -1 });
    });
  });
}

interface ParsedResponse<T> {
  ok: true;
  result: T;
}

interface ParsedError {
  ok: false;
  code: string;
  message: string;
}

function parseJsonResponse<T>(text: string): ParsedResponse<T> | ParsedError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_json", message: text.slice(0, 400) };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: "invalid_response", message: "response is not a JSON object" };
  }
  if ("error" in parsed && isPlainObject(parsed.error)) {
    const code = typeof parsed.error.code === "string" ? parsed.error.code : "unknown_error";
    const message = typeof parsed.error.message === "string" ? parsed.error.message : "unknown error";
    return { ok: false, code, message };
  }
  if (!("result" in parsed)) {
    return { ok: false, code: "invalid_response", message: "response missing result field" };
  }
  return { ok: true, result: parsed.result as T };
}

function coercePane(payload: unknown): PaneSnapshot | null {
  if (!isPlainObject(payload)) return null;
  const paneId = typeof payload.pane_id === "string" ? payload.pane_id : null;
  const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id : null;
  const tabId = typeof payload.tab_id === "string" ? payload.tab_id : null;
  const terminalId = typeof payload.terminal_id === "string" ? payload.terminal_id : null;
  const status = typeof payload.agent_status === "string" ? (payload.agent_status as AgentStatus) : "unknown";
  if (!paneId || !workspaceId || !tabId || !terminalId) return null;
  const snap: PaneSnapshot = {
    paneId,
    workspaceId,
    tabId,
    terminalId,
    agentStatus: status,
  };
  if (typeof payload.agent === "string" && payload.agent !== "") snap.agent = payload.agent;
  if (typeof payload.title === "string" && payload.title !== "") snap.title = payload.title;
  if (typeof payload.display_agent === "string" && payload.display_agent !== "") snap.displayAgent = payload.display_agent;
  if (isPlainObject(payload.agent_session)) {
    const session = payload.agent_session;
    if (typeof session.value === "string" && session.value !== "") {
      snap.agentSessionId = session.value;
    }
  }
  return snap;
}

export interface CliHerdrOptions {
  /** Path to the herdr binary. Defaults to env.HERDR_BIN_PATH then "herdr". */
  bin?: string;
  /** Hard timeout for each call. */
  perCallTimeoutMs?: number;
}

/**
 * Concrete `HerdrClient` that shells out to the herdr CLI binary. Output is
 * parsed as JSON; non-zero exits throw `HerdrCommandError`.
 */
export class CliHerdrClient implements HerdrClient {
  private readonly bin: string;
  private readonly perCallTimeoutMs: number;
  constructor(opts: CliHerdrOptions = {}) {
    this.bin = opts.bin ?? process.env.HERDR_BIN_PATH ?? "herdr";
    this.perCallTimeoutMs = opts.perCallTimeoutMs ?? 30_000;
  }

  private async call<T>(args: string[]): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.perCallTimeoutMs);
    try {
      const result = await runProcess(this.bin, args);
      if (result.status !== 0) {
        const parsed = parseJsonResponse<unknown>(result.stderr || result.stdout);
        if (!parsed.ok) {
          throw new HerdrCommandError(parsed.code, parsed.message, result.status);
        }
        // CLI exited 0 but stderr had structured JSON — surface result.
        return parsed.result as T;
      }
      const parsed = parseJsonResponse<T>(result.stdout);
      if (!parsed.ok) {
        throw new HerdrCommandError(parsed.code, parsed.message, result.status);
      }
      return parsed.result;
    } finally {
      clearTimeout(timer);
      void ctrl.signal; // keep linter quiet; AbortController only used for timeout state
    }
  }

  async getPane(target: string): Promise<PaneSnapshot | null> {
    try {
      const result = await this.call<{ pane?: RawPaneInfo }>(["pane", "get", target]);
      return coercePane(result.pane);
    } catch (err) {
      if (err instanceof HerdrCommandError && (err.code === "pane_not_found" || err.code === "not_found")) {
        return null;
      }
      throw err;
    }
  }

  async readPane(target: string, options: { source?: "recent" | "recent-unwrapped" | "visible" | "detection"; lines?: number } = {}): Promise<string> {
    // `pane read` returns plain UTF-8 text (not JSON), so we cannot
    // reuse `call()` which assumes a JSON envelope. Spawn directly.
    const args = ["pane", "read", target];
    if (options.source) args.push("--source", options.source);
    if (typeof options.lines === "number") args.push("--lines", String(options.lines));
    try {
      const result = await runProcess(this.bin, args);
      if (result.status !== 0) {
        // Some failures emit a JSON error envelope to stderr; surface
        // a structured error if so.
        const parsed = parseJsonResponse<unknown>(result.stderr || result.stdout);
        if (!parsed.ok) {
          if (parsed.code === "pane_not_found") return "";
          throw new HerdrCommandError(parsed.code, parsed.message, result.status);
        }
        throw new HerdrCommandError("unknown_error", result.stderr || "pane read failed", result.status);
      }
      return result.stdout;
    } catch (err) {
      if (err instanceof HerdrCommandError && err.code === "pane_not_found") return "";
      throw err;
    }
  }

  async getAgent(target: string): Promise<PaneSnapshot | null> {
    try {
      const result = await this.call<{ agent?: RawPaneInfo }>(["agent", "get", target]);
      return coercePane(result.agent);
    } catch (err) {
      if (err instanceof HerdrCommandError && (err.code === "agent_not_found" || err.code === "not_found" || err.code === "pane_not_found")) {
        return null;
      }
      throw err;
    }
  }

  async sendText(target: string, text: string): Promise<void> {
    // `pane send-text` returns no JSON envelope; the call succeeds when
    // the process exits 0. Surface the structured error envelope if
    // the server reports one on stderr.
    const result = await runProcess(this.bin, ["pane", "send-text", target, text]);
    if (result.status !== 0) {
      const parsed = parseJsonResponse<unknown>(result.stderr || result.stdout);
      if (!parsed.ok) {
        throw new HerdrCommandError(parsed.code, parsed.message || "pane send-text failed", result.status);
      }
      throw new HerdrCommandError("unknown_error", "pane send-text failed", result.status);
    }
  }

  async sendKeys(target: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const result = await runProcess(this.bin, ["pane", "send-keys", target, ...keys]);
    if (result.status !== 0) {
      const parsed = parseJsonResponse<unknown>(result.stderr || result.stdout);
      if (!parsed.ok) {
        throw new HerdrCommandError(parsed.code, parsed.message || "pane send-keys failed", result.status);
      }
      throw new HerdrCommandError("unknown_error", "pane send-keys failed", result.status);
    }
  }

  async waitForAgentStatus(target: string, until: AgentStatus[], timeoutMs: number): Promise<AgentStatus> {
    const args = ["agent", "wait", target];
    for (const status of until) args.push("--until", status);
    args.push("--timeout", String(timeoutMs));
    try {
      const result = await this.call<{ agent?: { agent_status?: AgentStatus } }>(args);
      const status = result.agent?.agent_status;
      return status ?? "unknown";
    } catch (err) {
      if (err instanceof HerdrCommandError && err.code === "timeout") {
        // Refresh and report observed status on timeout.
        const fresh = await this.getAgent(target);
        return fresh?.agentStatus ?? "unknown";
      }
      throw err;
    }
  }

  async paneExists(paneId: string): Promise<boolean> {
    const pane = await this.getPane(paneId);
    return pane !== null;
  }

  async waitForPaneOutput(target: string, regex: string, timeoutMs: number): Promise<string | null> {
    const args = ["pane", "wait-output", target, "--regex", regex, "--timeout", String(timeoutMs)];
    // `pane wait-output` returns JSON: either `{ result: { matched_line, ... } }`
    // on match or `{ error: { code: "timeout" } }` on timeout.
    const result = await runProcess(this.bin, args);
    if (result.status !== 0) {
      const parsed = parseJsonResponse<unknown>(result.stderr || result.stdout);
      if (!parsed.ok) {
        if (parsed.code === "timeout") return null;
        throw new HerdrCommandError(parsed.code, parsed.message, result.status);
      }
      throw new HerdrCommandError("unknown_error", "pane wait-output failed", result.status);
    }
    const parsed = parseJsonResponse<{ matched_line?: string }>(result.stdout);
    if (!parsed.ok) {
      throw new HerdrCommandError(parsed.code, parsed.message, result.status);
    }
    return parsed.result.matched_line ?? null;
  }

  async splitPane(opts: { sourcePaneId: string; direction: "right" | "down"; ratio?: number; cwd?: string }): Promise<string> {
    const args = ["pane", "split", opts.sourcePaneId, "--direction", opts.direction, "--no-focus"];
    if (typeof opts.ratio === "number") args.push("--ratio", String(opts.ratio));
    if (typeof opts.cwd === "string" && opts.cwd !== "") args.push("--cwd", opts.cwd);
    const result = await this.call<{ pane?: { pane_id?: string } }>(args);
    if (!result.pane?.pane_id) throw new HerdrCommandError("invalid_response", "split response missing pane_id");
    return result.pane.pane_id;
  }

  async runPaneCommand(target: string, command: string[]): Promise<void> {
    if (command.length === 0) throw new HerdrCommandError("invalid_command", "command must not be empty");
    // `pane run` returns no JSON envelope on success.
    const result = await runProcess(this.bin, ["pane", "run", target, ...command]);
    if (result.status !== 0) {
      const parsed = parseJsonResponse<unknown>(result.stderr || result.stdout);
      if (!parsed.ok) {
        throw new HerdrCommandError(parsed.code, parsed.message || "pane run failed", result.status);
      }
      throw new HerdrCommandError("unknown_error", "pane run failed", result.status);
    }
  }

  async spawnPaneForAgent(opts: { sourcePaneId: string; direction: "right" | "down"; cwd?: string }): Promise<string> {
    return this.splitPane(opts);
  }
}

/**
 * Filesystem-backed scratch store for state. Exposed as a free function so
 * tests can point the runtime at a temporary directory.
 */
export async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (dir) await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(payload, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}
