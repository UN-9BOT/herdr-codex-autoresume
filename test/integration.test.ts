// End-to-end integration test: simulate an event handler writing an intent
// and the scheduler draining it. This mirrors what happens when Herdr
// fires `pane.agent_status_changed` while the plugin is enabled.

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
const SESSION = "0190aaaa-bbbb-cccc-dddd-000000000001";
const MODEL_TEXT = "GPT-5.6-sol high · /tmp/proj · 5h 0% left · weekly 0% left\nYou've hit your usage limit. try again at 2026-09-24T20:00:01Z";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-e2e-"));
});

describe("end-to-end", () => {
  it("event handler intent -> scheduler drains and resumes via new pane", async () => {
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1", { agentSessionId: SESSION }) },
      texts: { "w1:p1": MODEL_TEXT },
      nextPaneIds: ["w1:p2"],
      dialogMatch: "Resume paused goal?",
    });
    const store = new StateStore(dir);

    await store.writeIntent({
      kind: "detect_limit",
      paneId: "w1:p1",
      agentKind: "codex",
      sessionId: SESSION,
      originalModel: "gpt-5.6-sol",
      detectedAtMs: NOW0,
      resetAtMs: NOW0 + 50,
      snippet: "You have hit your usage limit; try again at 2026-09-24T20:01:40Z",
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
    await new Promise((r) => setTimeout(r, 250));
    ac.abort();
    await promise;

    const state = await store.load();
    assert.equal(state.entries["w1:p1"]?.status, "resumed");
    assert.equal(herdr.splitPaneCalls.length, 1);
    assert.deepEqual(herdr.runPaneCommandCalls[0]?.command, ["codex", "-m", "gpt-5.6-sol", "resume", SESSION]);
    assert.equal(herdr.sendTextCalls[0]?.text, "1");
    assert.deepEqual(herdr.sendKeysCalls[0]?.keys, ["enter"]);
    assert.equal(state.entries["w1:p1"]?.resumePaneId, "w1:p2");
  });

  it("multiple Codex panes — each gets its independent /resume launch", async () => {
    const herdr = new FakeHerdr({
      panes: {
        "w1:p1": makeCodexPane("w1:p1", { agentSessionId: "w1p1-session" }),
        "w2:p2": makeCodexPane("w2:p2", { agentSessionId: "w2p2-session" }),
        "w3:p3": makeCodexPane("w3:p3", { agentSessionId: "w3p3-session" }),
      },
      texts: {
        "w1:p1": MODEL_TEXT,
        "w2:p2": MODEL_TEXT,
        "w3:p3": MODEL_TEXT,
      },
      nextPaneIds: ["w1:p2", "w2:p3", "w3:p4"],
      dialogMatch: "Resume paused goal?",
    });
    const store = new StateStore(dir);
    for (const paneId of ["w1:p1", "w2:p2", "w3:p3"]) {
      await store.writeIntent({
        kind: "detect_limit",
        paneId,
        agentKind: "codex",
        sessionId: paneId.replace(":", "") + "-session",
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
    await new Promise((r) => setTimeout(r, 1_200));
    ac.abort();
    await promise;
    const state = await store.load();
    for (const paneId of ["w1:p1", "w2:p2", "w3:p3"]) {
      assert.equal(state.entries[paneId]?.status, "resumed", `${paneId} should be resumed`);
    }
    assert.ok(herdr.splitPaneCalls.length >= 3);
    assert.ok(herdr.runPaneCommandCalls.length >= 3);
  });

  it("cancel intent stops a pending entry", async () => {
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1") },
      texts: { "w1:p1": MODEL_TEXT },
      nextPaneIds: ["w1:p2"],
    });
    const store = new StateStore(dir);
    await store.writeIntent({
      kind: "detect_limit",
      paneId: "w1:p1",
      agentKind: "codex",
      sessionId: SESSION,
      originalModel: "gpt-5.6-sol",
      detectedAtMs: NOW0,
      resetAtMs: NOW0 + 100,
      snippet: "usage limit hit",
    });
    await store.writeIntent({ kind: "cancel", paneId: "w1:p1", atMs: NOW0 + 50 });
    const cfg = { ...defaultConfig(), pollIntervalSeconds: 1 };
    const ac = new AbortController();
    const promise = runScheduler({ stateDir: dir, config: cfg, herdr, log: new NoopLogger(), now: () => NOW0 }, ac.signal);
    await new Promise((r) => setTimeout(r, 1_500));
    ac.abort();
    await promise;
    const state = await store.load();
    assert.equal(state.entries["w1:p1"]?.status, "cancelled");
    assert.equal(herdr.splitPaneCalls.length, 0);
  });

  it("cancel intent that arrives BEFORE detect_limit still cancels (lex-order race)", async () => {
    // Force the race by pre-seeding the cancelled list before the
    // scheduler sees the detect_limit intent.
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1") },
      texts: { "w1:p1": MODEL_TEXT },
      nextPaneIds: ["w1:p2"],
    });
    const store = new StateStore(dir);
    // Cancel arrives first.
    await store.writeIntent({ kind: "cancel", paneId: "w1:p1", atMs: NOW0 });
    // Then detect_limit.
    await store.writeIntent({
      kind: "detect_limit",
      paneId: "w1:p1",
      agentKind: "codex",
      sessionId: SESSION,
      originalModel: "gpt-5.6-sol",
      detectedAtMs: NOW0 + 1,
      resetAtMs: NOW0 + 100,
      snippet: "usage limit hit",
    });
    const cfg = { ...defaultConfig(), pollIntervalSeconds: 1 };
    const ac = new AbortController();
    const promise = runScheduler({ stateDir: dir, config: cfg, herdr, log: new NoopLogger(), now: () => NOW0 }, ac.signal);
    await new Promise((r) => setTimeout(r, 1_500));
    ac.abort();
    await promise;
    const state = await store.load();
    // Either the cancel suppressed the detect_limit (no entry, or
    // tombstone entry with status=cancelled and no resetAtMs), or the
    // detect_limit arrived first and the cancel subsequently flipped
    // its status to cancelled. In both cases status must be cancelled
    // and the scheduler must not have spawned a resume pane.
    const entry = state.entries["w1:p1"];
    if (entry) {
      assert.equal(entry.status, "cancelled", "entry must be marked cancelled");
    }
    assert.equal(herdr.splitPaneCalls.length, 0, "scheduler must not have spawned a resume pane");
  });
});

describe("e2e cleanup", () => {
  it("removes temp dir", async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    assert.ok(true);
  });
});
