// Action tests: status, resume-now, cancel.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../src/state.js";
import { buildStatusReport, formatStatus } from "../src/actions/status.js";
import { resumeNow } from "../src/actions/resume-now.js";
import { cancelResume } from "../src/actions/cancel.js";
import { FakeHerdr, makeCodexPane } from "./fake-herdr.js";

let dir: string;
let configDir: string;
let prevStateDir: string | undefined;
let prevConfigDir: string | undefined;
beforeEach(async () => {
  prevStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  prevConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  dir = await mkdtemp(join(tmpdir(), "codex-actions-"));
  configDir = await mkdtemp(join(tmpdir(), "codex-actions-cfg-"));
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
  process.env.HERDR_PLUGIN_CONFIG_DIR = configDir;
});
afterEach(() => {
  if (prevStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = prevStateDir;
  if (prevConfigDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  else process.env.HERDR_PLUGIN_CONFIG_DIR = prevConfigDir;
});

const SESSION = "0190aaaa-bbbb-cccc-dddd-000000000001";
const MODEL_TEXT = "GPT-5.6-sol high · /tmp/proj · 5h 0% left\nYou've hit your usage limit. try again at 2026-09-24T20:00:01Z";

describe("status", () => {
  it("reports empty when no entries", async () => {
    const report = await buildStatusReport(dir, {});
    assert.equal(report.allEntries.length, 0);
    assert.match(formatStatus(report), /No Codex auto-resume entries/);
  });

  it("formats pending entry", async () => {
    const store = new StateStore(dir);
    await store.save({
      version: 1,
      nextWakeAtMs: 0,
      entries: {
        "w1:p1": {
          paneId: "w1:p1",
          agentKind: "codex",
          detectedAtMs: Date.now() - 60_000,
          resetAtMs: Date.now() + 30_000,
          status: "waiting",
          resumeAttempts: 0,
          sessionId: SESSION,
          originalModel: "gpt-5.6-sol",
        },
      },
      modelsByPane: { "w1:p1": "gpt-5.6-sol" },
      cancelledPaneIds: [],
    });
    const report = await buildStatusReport(dir, {});
    assert.equal(report.allEntries.length, 1);
    const text = formatStatus(report);
    assert.match(text, /w1:p1/);
    assert.match(text, /waiting/);
    assert.match(text, /attempts:\s+0/);
  });
});

describe("resume-now", () => {
  it("invokes and records outcome via new pane flow", async () => {
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1", { agentSessionId: SESSION }) },
      texts: { "w1:p1": MODEL_TEXT },
      nextPaneIds: ["w1:p2"],
      dialogMatch: "Resume paused goal?",
    });
    const FIXED_NOW = Date.UTC(2026, 8, 24, 19, 59, 30); // 30s before the reset in the fixture
    const result = await resumeNow(dir, {
      paneId: "w1:p1",
      herdr,
      now: () => FIXED_NOW,
    });
    assert.equal(result.invoked, true);
    assert.equal(result.paneId, "w1:p1");
    assert.equal(result.resumePaneId, "w1:p2");
    const store = new StateStore(dir);
    const state = await store.load();
    assert.equal(state.entries["w1:p1"]?.status, "resumed");
    assert.deepEqual(herdr.runPaneCommandCalls[0]?.command, ["codex", "-m", "gpt-5.6-sol", "resume", SESSION]);
  });

  it("returns false when no pane id is provided", async () => {
    const result = await resumeNow(dir, { herdr: new FakeHerdr() });
    assert.equal(result.invoked, false);
  });
});

describe("cancel", () => {
  it("cancels a pending entry", async () => {
    const store = new StateStore(dir);
    await store.save({
      version: 1,
      nextWakeAtMs: 0,
      entries: {
        "w1:p1": {
          paneId: "w1:p1",
          agentKind: "codex",
          detectedAtMs: Date.now(),
          resetAtMs: Date.now() + 60_000,
          status: "waiting",
          resumeAttempts: 0,
        },
      },
      modelsByPane: {},
      cancelledPaneIds: [],
    });
    const result = await cancelResume(dir, { paneId: "w1:p1" });
    assert.equal(result.invoked, true);
    const drained = await store.drainIntents();
    assert.equal(drained.length, 1);
  });

  it("returns false for unknown pane", async () => {
    const result = await cancelResume(dir, { paneId: "missing" });
    assert.equal(result.invoked, false);
  });
});

describe("cleanup", () => {
  it("removes temp dir", async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    if (configDir) await rm(configDir, { recursive: true, force: true });
    assert.ok(true);
  });
});
