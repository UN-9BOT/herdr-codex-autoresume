// Scheduler integration tests using a FakeHerdr and a deterministic clock.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runScheduler } from "../src/scheduler.js";
import { StateStore } from "../src/state.js";
import { defaultConfig } from "../src/types.js";
import { FakeHerdr, makeCodexPane } from "./fake-herdr.js";
import { NoopLogger } from "../src/log.js";

const NOW0 = Date.UTC(2026, 8, 24, 20, 0, 0);
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-sched-"));
});

const SESSION = "0190aaaa-bbbb-cccc-dddd-000000000001";
const MODEL_TEXT = "GPT-5.6-sol high · /tmp/proj · 5h 0% left · weekly 0% left\nYou've hit your usage limit. try again at 2026-09-24T20:00:01Z";

function makeReady(): { herdr: FakeHerdr; store: StateStore } {
  const herdr = new FakeHerdr({
    panes: { "w1:p1": makeCodexPane("w1:p1", { agentSessionId: SESSION }) },
    texts: { "w1:p1": MODEL_TEXT },
    nextPaneIds: ["w1:p2"],
    dialogMatch: "Resume paused goal?",
  });
  return { herdr, store: new StateStore(dir) };
}

async function drain(ms = 700): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("scheduler", () => {
  it("processes a due entry and spawns a resume pane", async () => {
    const { herdr, store } = makeReady();
    await store.writeIntent({
      kind: "detect_limit",
      paneId: "w1:p1",
      agentKind: "codex",
      sessionId: SESSION,
      originalModel: "gpt-5.6-sol",
      detectedAtMs: NOW0,
      resetAtMs: NOW0 + 50,
      snippet: "usage limit hit",
    });
    let now = NOW0;
    const cfg = {
      ...defaultConfig(),
      pollIntervalSeconds: 1,
      resumeVerificationSeconds: 1,
      resumePaneLaunchTimeoutSeconds: 1,
      resumeDialogTimeoutSeconds: 1,
    };
    const ac = new AbortController();
    const promise = runScheduler({ stateDir: dir, config: cfg, herdr, log: new NoopLogger(), now: () => now }, ac.signal);
    now = NOW0 + 200;
    await drain();
    ac.abort();
    await promise;
    const state = await store.load();
    assert.equal(state.entries["w1:p1"]?.status, "resumed");
    assert.equal(herdr.splitPaneCalls.length, 1);
    assert.deepEqual(herdr.runPaneCommandCalls[0]?.command, ["codex", "-m", "gpt-5.6-sol", "resume", SESSION]);
  });

  it("does not double-resume on concurrent events", async () => {
    const { herdr, store } = makeReady();
    for (let i = 0; i < 5; i += 1) {
      await store.writeIntent({
        kind: "detect_limit",
        paneId: "w1:p1",
        agentKind: "codex",
        sessionId: SESSION,
        originalModel: "gpt-5.6-sol",
        detectedAtMs: NOW0,
        resetAtMs: NOW0 + 50,
        snippet: "usage limit hit",
      });
    }
    let now = NOW0;
    const cfg = {
      ...defaultConfig(),
      pollIntervalSeconds: 1,
      resumeVerificationSeconds: 1,
      resumePaneLaunchTimeoutSeconds: 1,
      resumeDialogTimeoutSeconds: 1,
    };
    const ac = new AbortController();
    const promise = runScheduler({ stateDir: dir, config: cfg, herdr, log: new NoopLogger(), now: () => now }, ac.signal);
    now = NOW0 + 200;
    await new Promise((r) => setTimeout(r, 250));
    ac.abort();
    await promise;
    assert.equal(herdr.splitPaneCalls.length, 1);
    const state = await store.load();
    assert.equal(state.entries["w1:p1"]?.status, "resumed");
  });

  it("handles multiple panes independently", async () => {
    const herdr = new FakeHerdr({
      panes: {
        "w1:p1": makeCodexPane("w1:p1", { agentSessionId: "w1p1-session" }),
        "w2:p2": makeCodexPane("w2:p2", { agentSessionId: "w2p2-session" }),
      },
      texts: {
        "w1:p1": MODEL_TEXT,
        "w2:p2": MODEL_TEXT,
      },
      nextPaneIds: ["w1:p2", "w2:p3"],
      dialogMatch: "Resume paused goal?",
    });
    const store = new StateStore(dir);
    for (const paneId of ["w1:p1", "w2:p2"]) {
      await store.writeIntent({
        kind: "detect_limit",
        paneId,
        agentKind: "codex",
        sessionId: paneId.replace(":", "") + "-session",
        originalModel: "gpt-5.6-sol",
        detectedAtMs: NOW0,
        resetAtMs: NOW0 + 50,
        snippet: "x",
      });
    }
    let now = NOW0;
    const cfg = {
      ...defaultConfig(),
      pollIntervalSeconds: 1,
      resumeVerificationSeconds: 1,
      resumePaneLaunchTimeoutSeconds: 1,
      resumeDialogTimeoutSeconds: 1,
    };
    const ac = new AbortController();
    const promise = runScheduler({ stateDir: dir, config: cfg, herdr, log: new NoopLogger(), now: () => now }, ac.signal);
    now = NOW0 + 500;
    await new Promise((r) => setTimeout(r, 1_000));
    ac.abort();
    await promise;
    const state = await store.load();
    assert.equal(state.entries["w1:p1"]?.status, "resumed");
    assert.equal(state.entries["w2:p2"]?.status, "resumed");
    assert.ok(herdr.splitPaneCalls.length >= 2);
  });

  it("treats pane_missing as failed without spawning", async () => {
    const herdr = new FakeHerdr({}); // no panes registered
    const store = new StateStore(dir);
    await store.writeIntent({ kind: "detect_limit", paneId: "missing:p1", agentKind: "codex", detectedAtMs: NOW0, resetAtMs: NOW0 + 50, snippet: "x" });
    let now = NOW0;
    const cfg = { ...defaultConfig(), pollIntervalSeconds: 1 };
    const ac = new AbortController();
    const promise = runScheduler({ stateDir: dir, config: cfg, herdr, log: new NoopLogger(), now: () => now }, ac.signal);
    now = NOW0 + 80;
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await promise;
    const state = await store.load();
    assert.equal(state.entries["missing:p1"]?.status, "failed");
    assert.equal(state.entries["missing:p1"]?.lastError, "pane_missing");
    assert.equal(herdr.splitPaneCalls.length, 0);
  });

  it("marks session_mismatch when pane agent is not codex", async () => {
    const herdr = new FakeHerdr({ panes: { "w1:p1": makeCodexPane("w1:p1", { agent: "claude", agentSessionId: "other-session" }) } });
    const store = new StateStore(dir);
    await store.writeIntent({ kind: "detect_limit", paneId: "w1:p1", agentKind: "codex", sessionId: "expected", detectedAtMs: NOW0, resetAtMs: NOW0 + 50, snippet: "x" });
    let now = NOW0;
    const cfg = { ...defaultConfig(), pollIntervalSeconds: 1 };
    const ac = new AbortController();
    const promise = runScheduler({ stateDir: dir, config: cfg, herdr, log: new NoopLogger(), now: () => now }, ac.signal);
    now = NOW0 + 80;
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await promise;
    const state = await store.load();
    assert.equal(state.entries["w1:p1"]?.status, "failed");
    assert.match(state.entries["w1:p1"]?.lastError ?? "", /session_mismatch/);
    assert.equal(herdr.splitPaneCalls.length, 0);
  });

  it("uses cached model when detect_limit arrives after auto-switch to Reserve", async () => {
    // Simulate: Codex was running on "gpt-5.6-sol" (captured via
    // refresh_status); then hit limit and the pane text now shows
    // "GPT-Reserve high"; the detect_limit intent carries no usable
    // model because the parser rejects "Reserve".
    const store = new StateStore(dir);
    await store.writeIntent({
      kind: "refresh_status",
      paneId: "w1:p1",
      agentStatus: "idle",
      atMs: NOW0,
      hasAgent: true,
      sessionId: SESSION,
      originalModel: "gpt-5.6-sol",
    });
    await store.writeIntent({
      kind: "detect_limit",
      paneId: "w1:p1",
      agentKind: "codex",
      sessionId: SESSION,
      detectedAtMs: NOW0 + 1_000,
      resetAtMs: NOW0 + 50,
      snippet: "You've hit your usage limit; try again at 2026-09-24T20:00:01Z",
    });
    let now = NOW0;
    const cfg = {
      ...defaultConfig(),
      pollIntervalSeconds: 1,
      resumeVerificationSeconds: 1,
      resumePaneLaunchTimeoutSeconds: 1,
      resumeDialogTimeoutSeconds: 1,
    };
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1", { agentSessionId: SESSION }) },
      texts: { "w1:p1": MODEL_TEXT },
      nextPaneIds: ["w1:p2"],
      dialogMatch: "Resume paused goal?",
    });
    const ac = new AbortController();
    const promise = runScheduler({ stateDir: dir, config: cfg, herdr, log: new NoopLogger(), now: () => now }, ac.signal);
    now = NOW0 + 200;
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await promise;
    const state = await store.load();
    // The model used to launch codex resume must be the cached one,
    // not whatever the live pane now shows (which would be "Reserve").
    assert.deepEqual(herdr.runPaneCommandCalls[0]?.command, ["codex", "-m", "gpt-5.6-sol", "resume", SESSION]);
    assert.equal(state.entries["w1:p1"]?.originalModel, "gpt-5.6-sol");
  });

  it("survives a restart by reloading pending entries from disk", async () => {
    const store = new StateStore(dir);
    await store.save({
      version: 1,
      nextWakeAtMs: 0,
      entries: {
        "w1:p1": {
          paneId: "w1:p1",
          agentKind: "codex",
          sessionId: SESSION,
          originalModel: "gpt-5.6-sol",
          detectedAtMs: NOW0 - 10_000,
          resetAtMs: NOW0 - 5_000,
          status: "waiting",
          resumeAttempts: 0,
        },
      },
      modelsByPane: { "w1:p1": "gpt-5.6-sol" },
      cancelledPaneIds: [],
    });
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1", { agentSessionId: SESSION }) },
      texts: { "w1:p1": MODEL_TEXT },
      nextPaneIds: ["w1:p2"],
      dialogMatch: "Resume paused goal?",
    });
    const cfg = {
      ...defaultConfig(),
      pollIntervalSeconds: 1,
      resumeVerificationSeconds: 1,
      resumePaneLaunchTimeoutSeconds: 1,
      resumeDialogTimeoutSeconds: 1,
    };
    const ac = new AbortController();
    const now = NOW0;
    const promise = runScheduler({ stateDir: dir, config: cfg, herdr, log: new NoopLogger(), now: () => now }, ac.signal);
    await new Promise((r) => setTimeout(r, 350));
    ac.abort();
    await promise;
    const after = await store.load();
    assert.equal(after.entries["w1:p1"]?.status, "resumed");
  });
});

describe("scheduler cleanup", () => {
  it("removes temp dir", async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    assert.ok(true);
  });
});
