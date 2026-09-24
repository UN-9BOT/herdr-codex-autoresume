import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG, defaultConfig, type PluginConfig } from "./types.js";

const CONFIG_FILE_NAME = "config.json";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseConfigObject(raw: unknown): PluginConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("config root must be a JSON object");
  }
  const cfg = defaultConfig();
  if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
  if (typeof raw.resumeCommand === "string" && raw.resumeCommand.trim() !== "") {
    cfg.resumeCommand = raw.resumeCommand;
  }
  if (typeof raw.defaultCodexModel === "string" && raw.defaultCodexModel.trim() !== "") {
    cfg.defaultCodexModel = raw.defaultCodexModel.trim();
  }
  if (raw.splitDirection === "right" || raw.splitDirection === "down") {
    cfg.splitDirection = raw.splitDirection;
  }
  if (typeof raw.maxReadLines === "number" && Number.isFinite(raw.maxReadLines)) {
    cfg.maxReadLines = Math.max(20, Math.min(2000, Math.floor(raw.maxReadLines)));
  }
  if (typeof raw.retryMaxSeconds === "number" && Number.isFinite(raw.retryMaxSeconds)) {
    cfg.retryMaxSeconds = Math.max(5, Math.min(3600, Math.floor(raw.retryMaxSeconds)));
  }
  if (typeof raw.resumePaneLaunchTimeoutSeconds === "number" && Number.isFinite(raw.resumePaneLaunchTimeoutSeconds)) {
    cfg.resumePaneLaunchTimeoutSeconds = Math.max(5, Math.min(300, Math.floor(raw.resumePaneLaunchTimeoutSeconds)));
  }
  if (typeof raw.resumeDialogTimeoutSeconds === "number" && Number.isFinite(raw.resumeDialogTimeoutSeconds)) {
    cfg.resumeDialogTimeoutSeconds = Math.max(2, Math.min(120, Math.floor(raw.resumeDialogTimeoutSeconds)));
  }
  if (typeof raw.resumeVerificationSeconds === "number" && Number.isFinite(raw.resumeVerificationSeconds)) {
    cfg.resumeVerificationSeconds = Math.max(2, Math.min(120, Math.floor(raw.resumeVerificationSeconds)));
  }
  if (typeof raw.pollIntervalSeconds === "number" && Number.isFinite(raw.pollIntervalSeconds)) {
    cfg.pollIntervalSeconds = Math.max(2, Math.min(600, Math.floor(raw.pollIntervalSeconds)));
  }
  if (typeof raw.dryRun === "boolean") cfg.dryRun = raw.dryRun;
  if (typeof raw.simulationFixturePath === "string" && raw.simulationFixturePath.trim() !== "") {
    cfg.simulationFixturePath = raw.simulationFixturePath;
  }
  if (typeof raw.simulationPostResumeFixturePath === "string" && raw.simulationPostResumeFixturePath.trim() !== "") {
    cfg.simulationPostResumeFixturePath = raw.simulationPostResumeFixturePath;
  }
  return cfg;
}

export interface ConfigPaths {
  configDir: string;
  stateDir: string;
}

export function resolveConfigPaths(env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR;
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!configDir || !stateDir) {
    throw new ConfigError(
      "HERDR_PLUGIN_CONFIG_DIR and HERDR_PLUGIN_STATE_DIR are required for the plugin to operate.",
    );
  }
  return { configDir, stateDir };
}

export async function loadConfig(
  paths: ConfigPaths = resolveConfigPaths(),
): Promise<PluginConfig> {
  await mkdir(paths.configDir, { recursive: true });
  const file = join(paths.configDir, CONFIG_FILE_NAME);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const initial = JSON.stringify(DEFAULT_CONFIG, null, 2);
      await writeFile(file, initial + "\n", "utf8");
      return defaultConfig();
    }
    throw new ConfigError(`failed to read ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`failed to parse ${file}: ${(err as Error).message}`);
  }
  return parseConfigObject(parsed);
}

/**
 * Write a freshly-constructed config object to disk. Used by tests and by
 * the `Config` action helper, never called from hot paths.
 */
export async function writeConfig(
  paths: ConfigPaths,
  cfg: PluginConfig,
): Promise<void> {
  await mkdir(dirname(join(paths.configDir, CONFIG_FILE_NAME)), { recursive: true });
  await writeFile(
    join(paths.configDir, CONFIG_FILE_NAME),
    JSON.stringify(cfg, null, 2) + "\n",
    "utf8",
  );
}
