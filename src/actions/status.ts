import { StateStore } from "../state.js";
import type { ResumeEntry } from "../types.js";

export interface StatusOptions {
  paneId?: string;
  json?: boolean;
}

export interface StatusReport {
  enabled: boolean;
  paneId: string | null;
  entry: ResumeEntry | null;
  allEntries: ResumeEntry[];
  schedulerRunning: boolean;
  generatedAtMs: number;
}

export async function buildStatusReport(
  stateDir: string,
  opts: StatusOptions,
): Promise<StatusReport> {
  const store = new StateStore(stateDir);
  const state = await store.load();
  const all = Object.values(state.entries).sort((a, b) => a.detectedAtMs - b.detectedAtMs);
  const target = opts.paneId ? state.entries[opts.paneId] ?? null : null;
  return {
    enabled: true,
    paneId: target?.paneId ?? opts.paneId ?? null,
    entry: target,
    allEntries: all,
    schedulerRunning: false,
    generatedAtMs: Date.now(),
  };
}

export function formatStatus(report: StatusReport): string {
  if (!report.entry && report.paneId) {
    return `No pending auto-resume for pane ${report.paneId}.\n`;
  }
  if (report.allEntries.length === 0) {
    return "No Codex auto-resume entries.\n";
  }
  const lines: string[] = [];
  for (const e of report.allEntries) {
    lines.push(formatEntry(e, report.generatedAtMs));
  }
  return lines.join("\n") + "\n";
}

export function formatEntry(e: ResumeEntry, nowMs: number): string {
  const left = typeof e.resetAtMs === "number" ? Math.max(0, Math.round((e.resetAtMs - nowMs) / 1000)) : null;
  const leftStr = left === null ? "n/a" : formatDuration(left);
  return [
    `pane:      ${e.paneId}`,
    `session:   ${e.sessionId ?? "(unknown)"}`,
    `status:    ${e.status}`,
    `attempts:  ${e.resumeAttempts}`,
    `reset_at:  ${typeof e.resetAtMs === "number" ? new Date(e.resetAtMs).toISOString() : "(unknown)"}`,
    `eta:       ${leftStr}`,
    `last_err:  ${e.lastError ?? "(none)"}`,
  ].join("\n");
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
