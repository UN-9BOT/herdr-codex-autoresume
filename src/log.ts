import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Logger, LoggerFields } from "./types.js";

const REDACT_KEYS = new Set([
  "token",
  "password",
  "secret",
  "codexSession",
  "codex_session",
  "openaiApiKey",
]);

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 400 ? value.slice(0, 400) + "…[snip]" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export interface LogLine {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields?: Record<string, unknown>;
}

/**
 * Format one log line as a single line of JSON. Stdout is fine for short
 * one-shot processes; the scheduler opens a file stream for persistent
 * logs.
 */
export function formatLine(line: LogLine): string {
  return JSON.stringify({
    ts: line.ts,
    level: line.level,
    event: line.event,
    ...(line.fields ?? {}),
  });
}

export class StdLogger implements Logger {
  constructor(private readonly now: () => Date = () => new Date()) {}

  info(event: string, fields?: LoggerFields): void {
    process.stdout.write(formatLine({ ts: this.now().toISOString(), level: "info", event, fields: fields as Record<string, unknown> | undefined }) + "\n");
  }
  warn(event: string, fields?: LoggerFields): void {
    process.stderr.write(formatLine({ ts: this.now().toISOString(), level: "warn", event, fields: fields as Record<string, unknown> | undefined }) + "\n");
  }
  error(event: string, fields?: LoggerFields): void {
    process.stderr.write(formatLine({ ts: this.now().toISOString(), level: "error", event, fields: fields as Record<string, unknown> | undefined }) + "\n");
  }
  debug(event: string, fields?: LoggerFields): void {
    if (process.env.HERDR_AUTORESUME_DEBUG === "1") {
      process.stdout.write(formatLine({ ts: this.now().toISOString(), level: "debug", event, fields: fields as Record<string, unknown> | undefined }) + "\n");
    }
  }
}

export interface FileLoggerOptions {
  stateDir: string;
  fileName?: string;
}

/**
 * A logger that writes to a rolling JSON-lines file under the plugin state
 * directory. The scheduler uses this so its output survives detached
 * shutdown. Tests use the StdLogger.
 */
export class FileLogger implements Logger {
  private readonly stream: NodeJS.WritableStream;
  private readonly buf: string[] = [];
  private readonly limit = 200;

  constructor(private readonly opts: FileLoggerOptions) {
    mkdirSync(opts.stateDir, { recursive: true });
    const file = join(opts.stateDir, opts.fileName ?? "scheduler.log");
    this.stream = createWriteStream(file, { flags: "a" });
  }

  private write(level: LogLine["level"], event: string, fields?: LoggerFields): void {
    const line = formatLine({
      ts: new Date().toISOString(),
      level,
      event,
      fields: fields ? (sanitize(fields) as Record<string, unknown>) : undefined,
    });
    this.buf.push(line);
    if (this.buf.length > this.limit) this.buf.shift();
    this.stream.write(line + "\n");
  }

  info(event: string, fields?: LoggerFields): void {
    this.write("info", event, fields);
  }
  warn(event: string, fields?: LoggerFields): void {
    this.write("warn", event, fields);
  }
  error(event: string, fields?: LoggerFields): void {
    this.write("error", event, fields);
  }
  debug(event: string, fields?: LoggerFields): void {
    if (process.env.HERDR_AUTORESUME_DEBUG === "1") {
      this.write("debug", event, fields);
    }
  }
}

export class NoopLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
  debug(): void {}
}
