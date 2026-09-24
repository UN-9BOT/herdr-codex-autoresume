// Reusable in-memory HerdrClient for tests.

import type {
  HerdrClient,
  PaneSnapshot,
} from "../src/herdr.js";
import type { AgentStatus } from "../src/types.js";

export interface FakeHerdrOptions {
  panes?: Record<string, PaneSnapshot>;
  texts?: Record<string, string>;
  /** When true, sendText/sendKeys throw a synthetic error. */
  rejectSend?: boolean;
  /** When set, new panes created by `splitPane` get these IDs in sequence. */
  nextPaneIds?: string[];
  /** When set, `waitForPaneOutput` returns this string instead of polling. */
  dialogMatch?: string | null;
}

export class FakeHerdr implements HerdrClient {
  readonly sendTextCalls: Array<{ target: string; text: string }> = [];
  readonly sendKeysCalls: Array<{ target: string; keys: string[] }> = [];
  readonly splitPaneCalls: Array<{ sourcePaneId: string; direction: "right" | "down" }> = [];
  readonly runPaneCommandCalls: Array<{ target: string; command: string[] }> = [];
  private panes: Record<string, PaneSnapshot>;
  private texts: Record<string, string>;
  private rejectSend: boolean;
  private nextPaneIds: string[];
  private dialogMatch: string | null;

  constructor(opts: FakeHerdrOptions = {}) {
    this.panes = { ...(opts.panes ?? {}) };
    this.texts = { ...(opts.texts ?? {}) };
    this.rejectSend = opts.rejectSend ?? false;
    this.nextPaneIds = [...(opts.nextPaneIds ?? [])];
    this.dialogMatch = opts.dialogMatch ?? null;
  }

  setPane(pane: PaneSnapshot): void {
    this.panes[pane.paneId] = pane;
  }
  setText(paneId: string, text: string): void {
    this.texts[paneId] = text;
  }
  removePane(paneId: string): void {
    delete this.panes[paneId];
  }
  setDialogMatch(match: string | null): void {
    this.dialogMatch = match;
  }

  async getPane(target: string): Promise<PaneSnapshot | null> {
    return this.panes[target] ?? null;
  }
  async readPane(target: string): Promise<string> {
    return this.texts[target] ?? "";
  }
  async getAgent(target: string): Promise<PaneSnapshot | null> {
    return this.panes[target] ?? null;
  }
  async sendText(target: string, text: string): Promise<void> {
    if (this.rejectSend) throw new Error("send rejected");
    this.sendTextCalls.push({ target, text });
  }
  async sendKeys(target: string, keys: string[]): Promise<void> {
    if (this.rejectSend) throw new Error("send rejected");
    this.sendKeysCalls.push({ target, keys });
  }
  async waitForAgentStatus(target: string, until: AgentStatus[]): Promise<AgentStatus> {
    const pane = this.panes[target];
    if (!pane) return "unknown";
    return until.includes(pane.agentStatus) ? pane.agentStatus : pane.agentStatus;
  }
  async paneExists(paneId: string): Promise<boolean> {
    return Boolean(this.panes[paneId]);
  }

  async waitForPaneOutput(target: string, regex: string, _timeoutMs: number): Promise<string | null> {
    const text = this.texts[target] ?? "";
    // When `dialogMatch` is set we treat any targeted wait as a positive
    // match (the test fixture author asserts the regex pattern is correct).
    if (this.dialogMatch !== null && this.dialogMatch !== undefined) {
      return this.dialogMatch;
    }
    if (new RegExp(regex).test(text)) return text.split("\n", 1)[0] ?? "matched";
    return null;
  }

  async splitPane(opts: { sourcePaneId: string; direction: "right" | "down"; ratio?: number; cwd?: string }): Promise<string> {
    this.splitPaneCalls.push({ sourcePaneId: opts.sourcePaneId, direction: opts.direction });
    if (this.nextPaneIds.length === 0) {
      throw new Error("FakeHerdr: no more nextPaneIds configured");
    }
    const id = this.nextPaneIds.shift()!;
    const parent = this.panes[opts.sourcePaneId];
    const newPane: PaneSnapshot = {
      paneId: id,
      workspaceId: parent?.workspaceId ?? "w1",
      tabId: parent?.tabId ?? "w1:t1",
      terminalId: `term_${id}`,
      agent: "codex",
      agentStatus: "idle",
      agentSessionId: parent?.agentSessionId,
    };
    this.panes[id] = newPane;
    this.texts[id] = this.texts[id] ?? "";
    return id;
  }

  async runPaneCommand(target: string, command: string[]): Promise<void> {
    this.runPaneCommandCalls.push({ target, command });
    // Mark the pane as codex-launching (not yet idle until we observe a status).
    const pane = this.panes[target];
    if (pane) {
      this.panes[target] = { ...pane, agent: "codex", agentStatus: pane.agentStatus ?? "unknown" };
    }
  }

  async spawnPaneForAgent(opts: { sourcePaneId: string; direction: "right" | "down"; cwd?: string }): Promise<string> {
    return this.splitPane(opts);
  }
}

export function makeCodexPane(paneId: string, opts: Partial<PaneSnapshot> = {}): PaneSnapshot {
  return {
    paneId,
    workspaceId: opts.workspaceId ?? "w1",
    tabId: opts.tabId ?? "w1:t1",
    terminalId: opts.terminalId ?? `term_${paneId}`,
    agent: opts.agent ?? "codex",
    agentStatus: opts.agentStatus ?? "idle",
    title: opts.title,
    displayAgent: opts.displayAgent,
    agentSessionId: opts.agentSessionId ?? "0190aaaa-bbbb-cccc-dddd-000000000001",
  };
}
