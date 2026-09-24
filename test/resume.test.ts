// Resume orchestration tests with FakeHerdr.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/types.js";
import { performResume, preflightResume } from "../src/resume.js";
import { FakeHerdr, makeCodexPane } from "./fake-herdr.js";
import { NoopLogger } from "../src/log.js";

const NOW = Date.UTC(2026, 8, 24, 20, 0, 0);

function baseDeps(herdr: FakeHerdr) {
  return {
    herdr,
    config: {
      ...defaultConfig(),
      resumeVerificationSeconds: 1,
      resumePaneLaunchTimeoutSeconds: 1,
      resumeDialogTimeoutSeconds: 1,
    },
    log: new NoopLogger(),
    now: () => NOW,
  };
}

const LIMIT_TEXT = "You've hit your usage limit; try again at 2026-09-24T20:01:00Z\n› Ask Codex";
const MODEL_TEXT = "GPT-5.6-sol high · ~/.hermes/projects/faststo/research/chatgpt-shadow-harness · Context 91% used\n" + LIMIT_TEXT;

describe("preflightResume", () => {
  it("returns pane_missing when pane is gone", async () => {
    const herdr = new FakeHerdr();
    const pre = await preflightResume("missing", undefined, undefined, baseDeps(herdr));
    assert.equal(pre.outcome?.kind, "pane_missing");
  });

  it("returns session_mismatch when agent is not codex", async () => {
    const herdr = new FakeHerdr({ panes: { "w1:p1": makeCodexPane("w1:p1", { agent: "claude" }) } });
    const pre = await preflightResume("w1:p1", undefined, undefined, baseDeps(herdr));
    assert.equal(pre.outcome?.kind, "session_mismatch");
  });

  it("returns session_mismatch when agent_session_id changed", async () => {
    const herdr = new FakeHerdr({ panes: { "w1:p1": makeCodexPane("w1:p1", { agentSessionId: "different" }) } });
    const pre = await preflightResume("w1:p1", "expected-id", undefined, baseDeps(herdr));
    assert.equal(pre.outcome?.kind, "session_mismatch");
  });

  it("returns already_resumed when pane text no longer shows the limit", async () => {
    const herdr = new FakeHerdr({ panes: { "w1:p1": makeCodexPane("w1:p1") }, texts: { "w1:p1": "› ask me anything" } });
    const pre = await preflightResume("w1:p1", undefined, undefined, baseDeps(herdr));
    assert.equal(pre.outcome?.kind, "already_resumed");
  });

  it("extracts model from pane text", async () => {
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1") },
      texts: { "w1:p1": MODEL_TEXT },
    });
    const pre = await preflightResume("w1:p1", undefined, undefined, baseDeps(herdr));
    assert.equal(pre.model, "GPT-5.6-sol");
    assert.equal(pre.outcome, undefined);
  });

  it("returns model_unknown when text has no quality keyword", async () => {
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1") },
      texts: { "w1:p1": LIMIT_TEXT },
    });
    const pre = await preflightResume("w1:p1", undefined, undefined, baseDeps(herdr));
    assert.equal(pre.outcome?.kind, "model_unknown");
  });
});

describe("performResume", () => {
  it("spawns a new pane and runs codex -m <model> resume <session>", async () => {
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1") },
      texts: { "w1:p1": MODEL_TEXT },
      nextPaneIds: ["w1:p2"],
      dialogMatch: "Resume paused goal?",
    });
    const entry = {
      paneId: "w1:p1",
      agentKind: "codex" as const,
      sessionId: "0190aaaa-bbbb-cccc-dddd-000000000001",
      originalModel: "gpt-5.6-sol",
      detectedAtMs: NOW,
      resetAtMs: NOW - 100,
      status: "waiting" as const,
      resumeAttempts: 0,
    };
    const result = await performResume(entry, baseDeps(herdr));
    assert.equal(result.outcome.kind, "resumed");
    assert.equal(herdr.splitPaneCalls.length, 1);
    assert.deepEqual(herdr.runPaneCommandCalls[0]?.command, ["codex", "-m", "gpt-5.6-sol", "resume", entry.sessionId]);
    assert.deepEqual(herdr.sendTextCalls[0]?.text, "1");
    assert.deepEqual(herdr.sendKeysCalls[0]?.keys, ["enter"]);
  });

  it("returns still_limited when resetAtMs is in the future", async () => {
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1") },
      texts: { "w1:p1": MODEL_TEXT },
    });
    const entry = {
      paneId: "w1:p1",
      agentKind: "codex" as const,
      sessionId: "0190aaaa-bbbb-cccc-dddd-000000000001",
      originalModel: "gpt-5.6-sol",
      detectedAtMs: NOW,
      resetAtMs: NOW + 60_000,
      status: "waiting" as const,
      resumeAttempts: 0,
    };
    const result = await performResume(entry, baseDeps(herdr));
    assert.equal(result.outcome.kind, "still_limited");
    assert.equal(herdr.splitPaneCalls.length, 0);
  });

  it("does not spawn when dryRun is set", async () => {
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1") },
      texts: { "w1:p1": MODEL_TEXT },
    });
    const entry = {
      paneId: "w1:p1",
      agentKind: "codex" as const,
      sessionId: "0190aaaa-bbbb-cccc-dddd-000000000001",
      originalModel: "gpt-5.6-sol",
      detectedAtMs: NOW,
      resetAtMs: NOW - 100,
      status: "waiting" as const,
      resumeAttempts: 0,
    };
    const deps = { ...baseDeps(herdr), config: { ...baseDeps(herdr).config, dryRun: true } };
    const result = await performResume(entry, deps);
    assert.equal(result.outcome.kind, "skipped_dry_run");
    assert.equal(herdr.splitPaneCalls.length, 0);
  });

  it("returns dialog_missing when the dialog regex never matches", async () => {
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1") },
      texts: { "w1:p1": MODEL_TEXT, "w1:p2": "no dialog here" },
      nextPaneIds: ["w1:p2"],
      dialogMatch: null,
    });
    const entry = {
      paneId: "w1:p1",
      agentKind: "codex" as const,
      sessionId: "0190aaaa-bbbb-cccc-dddd-000000000001",
      originalModel: "gpt-5.6-sol",
      detectedAtMs: NOW,
      resetAtMs: NOW - 100,
      status: "waiting" as const,
      resumeAttempts: 0,
    };
    const result = await performResume(entry, baseDeps(herdr));
    assert.equal(result.outcome.kind, "dialog_missing");
  });

  it("never sends anything other than the resume command and dialog answer", async () => {
    const herdr = new FakeHerdr({
      panes: { "w1:p1": makeCodexPane("w1:p1") },
      texts: { "w1:p1": MODEL_TEXT },
      nextPaneIds: ["w1:p2"],
      dialogMatch: "Resume paused goal?",
    });
    const entry = {
      paneId: "w1:p1",
      agentKind: "codex" as const,
      sessionId: "0190aaaa-bbbb-cccc-dddd-000000000001",
      originalModel: "gpt-5.6-sol",
      detectedAtMs: NOW,
      resetAtMs: NOW - 100,
      status: "waiting" as const,
      resumeAttempts: 0,
    };
    await performResume(entry, baseDeps(herdr));
    for (const call of herdr.runPaneCommandCalls) {
      // The plugin only launches `codex -m <model> resume <sessionId>`; nothing else.
      assert.equal(call.command[0], "codex", `unexpected command: ${call.command.join(" ")}`);
      assert.equal(call.command[1], "-m");
      assert.equal(call.command[2], "gpt-5.6-sol");
      assert.equal(call.command[3], "resume");
      assert.equal(call.command[4], entry.sessionId);
    }
    for (const call of herdr.sendTextCalls) {
      // Only "1" is allowed as a literal (to answer the dialog).
      assert.ok(call.text === "1", `unexpected literal text: ${call.text}`);
    }
    for (const call of herdr.sendKeysCalls) {
      // Only Enter is allowed.
      assert.deepEqual(call.keys, ["enter"]);
    }
  });
});
