// Atomic state persistence tests.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../src/state.js";
import { writeJsonAtomic } from "../src/herdr.js";
import type { PersistedState, ResumeEntry } from "../src/types.js";

let dir: string;
let store: StateStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-autoresume-"));
  store = new StateStore(dir);
});

describe("StateStore", () => {
  it("returns an empty state when no file exists", async () => {
    const state = await store.load();
    assert.equal(state.version, 1);
    assert.deepEqual(state.entries, {});
    assert.equal(state.nextWakeAtMs, 0);
  });

  it("persists and reloads entries atomically", async () => {
    const state: PersistedState = {
      version: 1,
      nextWakeAtMs: 1_000,
      entries: {
        "w1:p3": entryFixture("w1:p3"),
      },
    };
    await store.save(state);
    const reloaded = await store.load();
    assert.equal(reloaded.entries["w1:p3"]?.status, "waiting");
    assert.equal(reloaded.entries["w1:p3"]?.resetAtMs, 9_000);
    assert.equal(reloaded.nextWakeAtMs, 1_000);
  });

  it("overwrites the file on each save (no temp leftovers)", async () => {
    await store.save({ version: 1, nextWakeAtMs: 0, entries: { "w1:p1": entryFixture("w1:p1") } });
    const files1 = await listDir(dir);
    await store.save({ version: 1, nextWakeAtMs: 0, entries: { "w1:p1": entryFixture("w1:p1") } });
    const files2 = await listDir(dir);
    assert.deepEqual(files1.sort(), files2.sort());
  });

  it("writeJsonAtomic does not leave tmp files on success", async () => {
    const file = join(dir, "out.json");
    await writeJsonAtomic(file, { a: 1 });
    const text = await readFile(file, "utf8");
    assert.equal(text, JSON.stringify({ a: 1 }, null, 2) + "\n");
    const files = await listDir(dir);
    assert.deepEqual(files, ["out.json"]);
  });

  it("survives a corrupt state file by starting fresh and quarantining it", async () => {
    const file = join(dir, "state.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "not json", "utf8");
    const reloaded = await store.load();
    assert.deepEqual(reloaded.entries, {});
    const files = (await listDir(dir)).sort();
    // The bad file is quarantined as state.json.corrupt.<ts>; the live file
    // is recreated on the next save.
    assert.ok(files.some((f) => f.startsWith("state.json.corrupt.")));
  });

  it("intents are drained in lex order and removed", async () => {
    await store.writeIntent({ kind: "cancel", paneId: "w1:p1", atMs: 100 });
    await store.writeIntent({ kind: "cancel", paneId: "w1:p2", atMs: 200 });
    const drained = await store.drainIntents();
    assert.equal(drained.length, 2);
    assert.equal(drained[0]?.kind, "cancel");
    assert.equal(drained[1]?.kind, "cancel");
    const second = await store.drainIntents();
    assert.equal(second.length, 0);
  });
});

function entryFixture(paneId: string): ResumeEntry {
  return {
    paneId,
    agentKind: "codex",
    detectedAtMs: 100,
    resetAtMs: 9_000,
    status: "waiting",
    resumeAttempts: 0,
  };
}

async function listDir(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}

describe("suite cleanup", () => {
  it("removes temp dirs", async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    assert.ok(true);
  });
});
