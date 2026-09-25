// Usage-limit detection.
//
// Codex's TUI does not have a stable, machine-readable signal for usage
// limits. The detector scans recent pane text for several known phrasings
// and extracts the reset time when one is present. Every regex / pattern
// is intentionally case-insensitive and accepts minor punctuation
// variation.

export interface LimitDetection {
  detected: boolean;
  /** Parsed absolute or relative reset time in epoch ms (UTC). */
  resetAtMs?: number;
  /** The matched fragment of pane text, capped to keep logs bounded. */
  rawMatchedText?: string;
  /** Diagnostic label identifying which rule fired. */
  rule?: string;
}

/**
 * Extract the Codex model name from the on-screen status line. The TUI
 * shows something like:
 *   "GPT-5.4 high · ~/.hermes/projects/foo · Context 91% used · ..."
 *   "gpt-5.6-sol high · ..."
 *   "GPT-6-Sol high · ..."
 *
 * Returns the raw model token (the slice before the size keyword) and
 * null when no recognizable model marker is present.
 */
export function detectCodexModel(text: string): string | null {
  if (!text) return null;
  // Allow uppercase/lowercase and optional dashes/dots, followed by a
  // quality keyword ("high" / "medium" / "low"). The dot separates major
  // and minor versions; dashes are also allowed.
  const m = text.match(/\b([A-Za-z][A-Za-z0-9][A-Za-z0-9.\-]{0,40})\s+(high|medium|low)\b/);
  if (!m || !m[1]) return null;
  const candidate = m[1].trim();
  if (!/^[A-Za-z][A-Za-z0-9.\-]{0,40}$/.test(candidate)) return null;
  // Skip lines that are clearly not the model header. The header is the
  // first token on the status line, so we look at the whole text and
  // accept the first match. Most Codex status lines have only one
  // quality keyword.
  return candidate;
}

/**
 * Sanity-check a candidate model name. After Codex hits a usage limit
 * it auto-switches the open TUI to a "Luna Reserve" model whose header
 * reads "GPT-Reserve high" — the raw parser accepts that as a model
 * name ("GPT-Reserve"), but it is the placeholder, not the user's
 * original model. This helper rejects the placeholder so the plugin
 * never uses it to relaunch `codex resume`.
 */
export function isLikelyCodexModel(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  if (lower === "reserve" || lower.includes("reserve")) return false;
  if (lower.length < 3) return false;
  return true;
}

export interface QuotaAvailable {
  detected: boolean;
  model?: string;
}

/**
 * Detect Codex's on-screen "switched back to <model>" indicator. When
 * the quota returns the TUI logs a bullet line:
 *   "Automatically switched back to gpt-5.6-sol high because ordinary
 *    usage is available again."
 * When that text is present, the user's goal is still paused but the
 * underlying quota window has reset — the plugin should not wait for
 * the scheduled resetAtMs and instead attempt a resume immediately.
 */
export function detectQuotaAvailable(text: string): QuotaAvailable {
  if (!text) return { detected: false };
  // Match: "Automatically switched back to <model> <quality>".
  const m = text.match(
    /switched\s+back\s+to\s+([A-Za-z][A-Za-z0-9.\-]{0,40})\s+(high|medium|low)\b/i,
  );
  if (!m || !m[1]) return { detected: false };
  const model = m[1];
  if (!isLikelyCodexModel(model)) return { detected: false };
  return { detected: true, model };
}

const MAX_SNIPPET = 200;

const LIMIT_KEYWORDS: Array<{ rule: string; pattern: RegExp }> = [
  // Codex's TUI prints apostrophes as typographic (’) which is U+2019,
  // not the ASCII straight quote we usually type. Accept both forms
  // throughout.
  { rule: "usage-limit-phrase", pattern: /you(?:['']ve| have) hit your usage limit/i },
  { rule: "usage-limit-keyword", pattern: /\busage limit\b/i },
  { rule: "rate-limit-keyword", pattern: /\brate[- ]?limit\b/i },
  { rule: "limit-resets-phrase", pattern: /\blimit\s+(?:will\s+)?resets?\b/i },
  { rule: "try-again-phrase", pattern: /\btry again\b/i },
  { rule: "quota-exceeded", pattern: /\bquota\s+exceeded\b/i },
  { rule: "exhausted", pattern: /\b(?:usage\s+)?exhausted\b/i },
];

interface RelativeMatch {
  resetAtMs: number;
  consumed: string;
  rule: string;
}

interface AbsoluteMatch {
  resetAtMs: number;
  consumed: string;
  rule: string;
}

/**
 * Parse a relative duration phrase like "in 1 hour 30 minutes" or "in 45m".
 * Returns the absolute epoch ms when added to `now`, or null when no
 * parseable duration is present.
 */
export function parseRelativeDuration(phrase: string, now: number): RelativeMatch | null {
  const cleaned = phrase.replace(/\s+/g, " ").trim();
  const m = cleaned.match(/\bin\s+((?:\d+\s*(?:hours?|hrs?|h)\s*)?(?:\d+\s*(?:minutes?|mins?|m)\s*)?(?:\d+\s*(?:seconds?|secs?|s)\s*)?)\b/i);
  if (!m || !m[1]) return null;
  const piece = m[1].trim();
  if (piece === "") return null;
  const hours = /(\d+)\s*(?:hours?|hrs?|h)\b/i.exec(piece);
  const minutes = /(\d+)\s*(?:minutes?|mins?|m)\b/i.exec(piece);
  const seconds = /(\d+)\s*(?:seconds?|secs?|s)\b/i.exec(piece);
  let totalMs = 0;
  let usedAny = false;
  if (hours) {
    totalMs += parseInt(hours[1]!, 10) * 3_600_000;
    usedAny = true;
  }
  if (minutes) {
    totalMs += parseInt(minutes[1]!, 10) * 60_000;
    usedAny = true;
  }
  if (seconds) {
    totalMs += parseInt(seconds[1]!, 10) * 1000;
    usedAny = true;
  }
  if (!usedAny) return null;
  return {
    resetAtMs: now + totalMs,
    consumed: m[0],
    rule: "relative-duration",
  };
}

interface AbsoluteComponents {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  tzOffsetMinutes?: number;
  meridiem?: "am" | "pm";
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function parseClock(hh: number, mm: number, meridiem?: "am" | "pm"): { hour: number; minute: number } | null {
  let hour = hh;
  const minute = mm;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function tzOffsetMinutes(tz: string): number | null {
  const trimmed = tz.trim();
  if (!trimmed) return null;
  if (trimmed.toUpperCase() === "UTC" || trimmed.toUpperCase() === "Z") return 0;
  const m = trimmed.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const sign = m[1] === "-" ? 1 : -1;
  const hours = parseInt(m[2]!, 10);
  const minutes = m[3] ? parseInt(m[3], 10) : 0;
  return sign * (hours * 60 + minutes);
}

function applyOffset(date: Date, offsetMinutes: number): number {
  // Return an absolute epoch ms that corresponds to the wall-clock time
  // described by `date` interpreted in a timezone `offsetMinutes` east of
  // UTC. (Sign convention: +HH:MM means local time is ahead of UTC.)
  return date.getTime() - offsetMinutes * 60_000;
}

function currentYear(): number {
  return new Date().getUTCFullYear();
}

interface AbsoluteParser {
  pattern: RegExp;
  build: (match: RegExpMatchArray, now: number) => AbsoluteMatch | null;
  rule: string;
}

const ABSOLUTE_PARSERS: AbsoluteParser[] = [
  // "until 2026-09-25 01:00 UTC" / "resets at 2026-09-25T01:00:00Z"
  {
    rule: "iso-datetime-with-tz",
    pattern: /\b(?:until|resets?\s+at|reset\s+at|try\s+again\s+at|at)\s+(\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:UTC|Z|[+-]\d{1,2}:?\d{2}))?)/i,
    build: (m, _now) => {
      const token = m[1]!;
      const iso = token.replace(" ", "T");
      const offsetMatch = /(Z|[+-]\d{1,2}:?\d{2})$/i.exec(iso);
      let offsetMinutes = 0;
      if (offsetMatch) {
        const token = offsetMatch[0];
        if (token.toUpperCase() === "Z") {
          offsetMinutes = 0;
        } else {
          const cleaned = token.replace(":", "");
          const sign = cleaned[0] === "-" ? -1 : 1;
          const hh = parseInt(cleaned.slice(1, 3), 10);
          const mm = parseInt(cleaned.slice(3, 5), 10) || 0;
          offsetMinutes = sign * (hh * 60 + mm);
        }
        const base = iso.slice(0, offsetMatch.index);
        const date = new Date(base + "Z");
        if (Number.isNaN(date.getTime())) return null;
        return { resetAtMs: applyOffset(date, offsetMinutes), consumed: m[0], rule: "iso-datetime-with-tz" };
      }
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return null;
      return { resetAtMs: date.getTime(), consumed: m[0], rule: "iso-datetime-with-tz" };
    },
  },
  // "until Sept 25 01:00 UTC" / "resets September 25 at 1:00 AM"
  // / "try again at Sep 25th, 2026 3:15 AM"
  {
    rule: "month-name-day-time",
    pattern:
      /\b(?:until|resets?\s+at|reset\s+at|try\s+again\s+at|at)\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?)?(?:\s*(UTC|Z|[+-]\d{1,2}:?\d{2}))?/,
    build: (m, now) => {
      const monthName = m[1]!.toLowerCase();
      const month = MONTH_NAMES[monthName];
      if (!month) return null;
      const day = parseInt(m[2]!, 10);
      const year = m[3] ? parseInt(m[3], 10) : currentYear();
      const hour = m[4] ? parseInt(m[4], 10) : 0;
      const minute = m[5] ? parseInt(m[5], 10) : 0;
      const meridiem = (m[6]?.toLowerCase() ?? undefined) as "am" | "pm" | undefined;
      const tz = m[7] ?? "";
      const clock = parseClock(hour, minute, meridiem);
      if (!clock) return null;
      const offsetMinutes = tz ? tzOffsetMinutes(tz) ?? 0 : 0;
      const date = new Date(Date.UTC(year, month - 1, day, clock.hour, clock.minute, 0));
      return { resetAtMs: applyOffset(date, offsetMinutes), consumed: m[0], rule: "month-name-day-time" };
    },
  },
  // "until 01:00 UTC" / "at 3:45 PM"
  {
    rule: "time-of-day",
    pattern:
      /\b(?:until|resets?\s+at|reset\s+at|try\s+again\s+at|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?(?:\s*(UTC|Z|[+-]\d{1,2}:?\d{2}))?/,
    build: (m, now) => {
      const hour = parseInt(m[1]!, 10);
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      const meridiem = (m[3]?.toLowerCase() ?? undefined) as "am" | "pm" | undefined;
      const tz = m[4] ?? "";
      const clock = parseClock(hour, minute, meridiem);
      if (!clock) return null;
      const nowDate = new Date(now);
      let date = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate(), clock.hour, clock.minute, 0));
      const offsetMinutes = tz ? tzOffsetMinutes(tz) ?? 0 : 0;
      if (date.getTime() + offsetMinutes * 60_000 < now) {
        // Roll to tomorrow.
        date = new Date(date.getTime() + 86_400_000);
      }
      return { resetAtMs: applyOffset(date, offsetMinutes), consumed: m[0], rule: "time-of-day" };
    },
  },
];

/**
 * Try every absolute-time parser in priority order. Returns the first
 * positive-resolution match.
 */
export function parseAbsoluteReset(text: string, now: number): AbsoluteMatch | null {
  for (const parser of ABSOLUTE_PARSERS) {
    const m = parser.pattern.exec(text);
    if (!m) continue;
    const parsed = parser.build(m, now);
    if (!parsed) continue;
    if (parsed.resetAtMs <= now) {
      // The parsed value already passed; treat as immediate.
      return { ...parsed, resetAtMs: now };
    }
    return parsed;
  }
  return null;
}

/**
 * Detect a usage limit message in `text` and extract the reset time when
 * one is present.
 */
export function detectUsageLimit(text: string, now: number = Date.now()): LimitDetection {
  if (!text) return { detected: false };

  let firstHit: { rule: string; index: number } | null = null;
  for (const keyword of LIMIT_KEYWORDS) {
    const m = keyword.pattern.exec(text);
    if (m && (firstHit === null || m.index < firstHit.index)) {
      firstHit = { rule: keyword.rule, index: m.index };
    }
  }
  if (!firstHit) return { detected: false };

  const window = text.slice(firstHit.index, Math.min(text.length, firstHit.index + 300));
  const snippet = window.replace(/\s+/g, " ").slice(0, MAX_SNIPPET);

  const abs = parseAbsoluteReset(window, now);
  const rel = abs ? null : parseRelativeDuration(window, now);
  const parsed = abs ?? rel;
  if (!parsed) {
    return {
      detected: true,
      rawMatchedText: snippet,
      rule: firstHit.rule,
    };
  }
  return {
    detected: true,
    resetAtMs: parsed.resetAtMs,
    rawMatchedText: snippet,
    rule: firstHit.rule,
  };
}

/**
 * Quick check used by event handlers: did the pane text shrink a usage
 * limit, and if so, is the parsed reset still in the future?
 */
export function isStillLimited(text: string, now: number = Date.now()): boolean {
  const detection = detectUsageLimit(text, now);
  if (!detection.detected) return false;
  if (typeof detection.resetAtMs === "number") return detection.resetAtMs > now;
  return true;
}
