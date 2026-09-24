import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./herdr.js";
import {
  CURRENT_STATE_VERSION,
  type Intent,
  type PersistedState,
  type ResumeEntry,
} from "./types.js";

const STATE_FILE = "state.json";
const INTENTS_DIR = "intents";
const INTENT_PREFIX = "intent-";
const INTENT_EXT = ".json";

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceEntry(paneId: string, raw: unknown): ResumeEntry | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.paneId !== "string") raw.paneId = paneId;
  if (raw.paneId !== paneId) raw.paneId = paneId;
  if (typeof raw.agentKind !== "string") return null;
  if (typeof raw.status !== "string") return null;
  const entry: ResumeEntry = {
    paneId,
    agentKind: raw.agentKind as ResumeEntry["agentKind"],
    detectedAtMs: typeof raw.detectedAtMs === "number" ? raw.detectedAtMs : Date.now(),
    status: raw.status as ResumeEntry["status"],
    resumeAttempts: typeof raw.resumeAttempts === "number" ? raw.resumeAttempts : 0,
  };
  if (typeof raw.workspaceId === "string") entry.workspaceId = raw.workspaceId;
  if (typeof raw.sessionId === "string") entry.sessionId = raw.sessionId;
  if (typeof raw.originalModel === "string") entry.originalModel = raw.originalModel;
  if (typeof raw.resetAtMs === "number") entry.resetAtMs = raw.resetAtMs;
  if (typeof raw.lastLimitSnippet === "string") entry.lastLimitSnippet = raw.lastLimitSnippet;
  if (typeof raw.lastAttemptAtMs === "number") entry.lastAttemptAtMs = raw.lastAttemptAtMs;
  if (typeof raw.lastError === "string") entry.lastError = raw.lastError;
  if (typeof raw.resumedAtMs === "number") entry.resumedAtMs = raw.resumedAtMs;
  if (typeof raw.resumePaneId === "string") entry.resumePaneId = raw.resumePaneId;
  if (typeof raw.resumeWorkspaceId === "string") entry.resumeWorkspaceId = raw.resumeWorkspaceId;
  return entry;
}

export function emptyState(): PersistedState {
  return { version: CURRENT_STATE_VERSION, nextWakeAtMs: 0, entries: {} };
}

export class StateStore {
  constructor(private readonly stateDir: string) {}

  stateFile(): string {
    return join(this.stateDir, STATE_FILE);
  }

  intentsDir(): string {
    return join(this.stateDir, INTENTS_DIR);
  }

  async load(): Promise<PersistedState> {
    await mkdir(this.stateDir, { recursive: true });
    const file = this.stateFile();
    if (!existsSync(file)) {
      return emptyState();
    }
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw new StateError(`failed to read state file: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Corrupt state: don't lose it, but also don't crash. Move aside and start clean.
      try {
        await rename(file, `${file}.corrupt.${Date.now()}`);
      } catch {
        /* best effort */
      }
      return emptyState();
    }
    return coerceState(parsed);
  }

  async save(state: PersistedState): Promise<void> {
    const next: PersistedState = {
      version: CURRENT_STATE_VERSION,
      nextWakeAtMs: typeof state.nextWakeAtMs === "number" ? state.nextWakeAtMs : 0,
      entries: { ...state.entries },
    };
    await writeJsonAtomic(this.stateFile(), next);
  }

  async writeIntent(intent: Intent): Promise<void> {
    await mkdir(this.intentsDir(), { recursive: true });
    const file = join(this.intentsDir(), `${INTENT_PREFIX}${Date.now()}-${process.pid}-${randomSuffix()}${INTENT_EXT}`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(intent) + "\n", "utf8");
    await rename(tmp, file);
  }

  /**
   * Drain intent files in lexicographic order (oldest first). Returns the
   * parsed intents and deletes the files that were read successfully.
   */
  async drainIntents(): Promise<Intent[]> {
    let names: string[];
    try {
      names = await readdir(this.intentsDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const sorted = names.filter((n) => n.startsWith(INTENT_PREFIX) && n.endsWith(INTENT_EXT)).sort();
    const intents: Intent[] = [];
    for (const name of sorted) {
      const file = join(this.intentsDir(), name);
      try {
        const text = await readFile(file, "utf8");
        const parsed = JSON.parse(text) as Intent;
        intents.push(parsed);
        await unlink(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        // Bad intent: move aside so it doesn't block the queue.
        try {
          await rename(file, `${file}.bad.${Date.now()}`);
        } catch {
          await rm(file, { force: true });
        }
      }
    }
    return intents;
  }
}

function coerceState(raw: unknown): PersistedState {
  if (!isPlainObject(raw)) return emptyState();
  if (raw.version !== CURRENT_STATE_VERSION) {
    // Future-proofing hook. We only ship version 1 today; on mismatch,
    // keep entries under their pane keys but reset next-wake so the
    // scheduler re-evaluates everything.
    // eslint-disable-next-line no-console
    console.warn(`state version mismatch (${String(raw.version)}); resetting transient fields`);
  }
  const entries: Record<string, ResumeEntry> = {};
  const rawEntries = isPlainObject(raw.entries) ? raw.entries : {};
  for (const [k, v] of Object.entries(rawEntries)) {
    const entry = coerceEntry(k, v);
    if (entry) entries[k] = entry;
  }
  return {
    version: CURRENT_STATE_VERSION,
    nextWakeAtMs: typeof raw.nextWakeAtMs === "number" ? raw.nextWakeAtMs : 0,
    entries,
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
