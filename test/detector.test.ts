// Unit tests for the usage-limit detector.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectCodexModel,
  detectUsageLimit,
  isLikelyCodexModel,
  isStillLimited,
  parseAbsoluteReset,
  parseRelativeDuration,
} from "../src/detector.js";

const NOW = Date.UTC(2026, 8, 24, 20, 0, 0); // 2026-09-24 20:00:00 UTC

describe("parseRelativeDuration", () => {
  it("parses hours and minutes", () => {
    const m = parseRelativeDuration("try again in 1 hour 30 minutes", NOW);
    assert.ok(m);
    assert.equal(m!.resetAtMs, NOW + (60 + 30) * 60 * 1000);
  });

  it("parses bare minutes", () => {
    const m = parseRelativeDuration("resets in 45m", NOW);
    assert.ok(m);
    assert.equal(m!.resetAtMs, NOW + 45 * 60 * 1000);
  });

  it("parses hours only", () => {
    const m = parseRelativeDuration("try again in 2 hours", NOW);
    assert.ok(m);
    assert.equal(m!.resetAtMs, NOW + 2 * 3_600_000);
  });

  it("rejects nonsense input", () => {
    assert.equal(parseRelativeDuration("hello world", NOW), null);
    assert.equal(parseRelativeDuration("", NOW), null);
    assert.equal(parseRelativeDuration("in", NOW), null);
  });
});

describe("parseAbsoluteReset", () => {
  it("parses iso datetime with UTC tz", () => {
    const m = parseAbsoluteReset("resets at 2026-09-25T01:00:00Z", NOW);
    assert.ok(m);
    assert.equal(m!.resetAtMs, Date.UTC(2026, 8, 25, 1, 0, 0));
  });

  it("parses iso datetime with positive offset", () => {
    const m = parseAbsoluteReset("resets at 2026-09-25T03:00:00+02:00", NOW);
    assert.ok(m);
    // 03:00 +02:00 == 01:00 UTC
    assert.equal(m!.resetAtMs, Date.UTC(2026, 8, 25, 1, 0, 0));
  });

  it("parses time of day with UTC rollover when parsed time is before now", () => {
    // Now is 22:00 UTC; "until 21:30 UTC" should roll to tomorrow.
    const m = parseAbsoluteReset("until 21:30 UTC", Date.UTC(2026, 8, 24, 22, 0, 0));
    assert.ok(m);
    assert.equal(m!.resetAtMs, Date.UTC(2026, 8, 25, 21, 30, 0));
  });

  it("parses time of day with same day when parsed time is still in the future", () => {
    // Now is 20:00 UTC; "until 21:30 UTC" should be today.
    const m = parseAbsoluteReset("until 21:30 UTC", Date.UTC(2026, 8, 24, 20, 0, 0));
    assert.ok(m);
    assert.equal(m!.resetAtMs, Date.UTC(2026, 8, 24, 21, 30, 0));
  });

  it("parses time of day with same day and meridiem", () => {
    const m = parseAbsoluteReset("resets at 11:45 PM", Date.UTC(2026, 8, 24, 22, 0, 0));
    assert.ok(m);
    assert.equal(m!.resetAtMs, Date.UTC(2026, 8, 24, 23, 45, 0));
  });

  it("parses month-name date", () => {
    const m = parseAbsoluteReset("until September 25 02:00 UTC", NOW);
    assert.ok(m);
    assert.equal(m!.resetAtMs, Date.UTC(2026, 8, 25, 2, 0, 0));
  });
});

describe("detectUsageLimit", () => {
  it("detects classic phrasing", () => {
    const text = "Some assistant output\nYou've hit your usage limit. try again at 2026-09-25T01:00:00Z\n";
    const d = detectUsageLimit(text, NOW);
    assert.equal(d.detected, true);
    assert.equal(d.resetAtMs, Date.UTC(2026, 8, 25, 1, 0, 0));
    assert.match(d.rawMatchedText ?? "", /usage limit/i);
  });

  it("detects rate limit", () => {
    const text = "Rate limit reached. try again in 5 minutes.\n";
    const d = detectUsageLimit(text, NOW);
    assert.equal(d.detected, true);
    assert.equal(d.resetAtMs, NOW + 5 * 60 * 1000);
  });

  it("detects limit resets phrase without parsed time", () => {
    const text = "Your limit resets tomorrow; check back then.";
    const d = detectUsageLimit(text, NOW);
    assert.equal(d.detected, true);
    assert.equal(typeof d.resetAtMs, "undefined");
  });

  it("ignores unrelated text", () => {
    const d = detectUsageLimit("Just chatting normally", NOW);
    assert.equal(d.detected, false);
  });

  it("handles empty input", () => {
    const d = detectUsageLimit("", NOW);
    assert.equal(d.detected, false);
  });

  it("caps snippet length", () => {
    const padding = "x".repeat(1_000);
    const text = `You've hit your usage limit. ${padding}`;
    const d = detectUsageLimit(text, NOW);
    assert.ok(d.rawMatchedText);
    assert.ok((d.rawMatchedText ?? "").length <= 200);
  });

  it("matches case insensitively", () => {
    const text = "USAGE LIMIT — please retry later";
    const d = detectUsageLimit(text, NOW);
    assert.equal(d.detected, true);
  });

  it("matches typographic apostrophes (Codex CLI style)", () => {
    const text = "■ You’ve hit your usage limit. Upgrade to Pro or try again at Sep 25th, 2026 3:15 AM.";
    const d = detectUsageLimit(text, NOW);
    assert.equal(d.detected, true);
  });

  it("parses 'Sep 25th, 2026 3:15 AM' style timestamps", () => {
    const text = "try again at Sep 25th, 2026 3:15 AM.";
    const d = detectUsageLimit(text, NOW);
    assert.equal(d.detected, true);
    // Sep 25, 2026 03:15 AM UTC == 2026-09-25 03:15:00Z
    assert.equal(d.resetAtMs, Date.UTC(2026, 8, 25, 3, 15, 0));
  });

  it("parses 'Sep 25, 2026' without ordinal suffix", () => {
    const text = "try again at Sep 25, 2026 3:15 AM";
    const d = detectUsageLimit(text, NOW);
    assert.equal(d.detected, true);
    assert.equal(d.resetAtMs, Date.UTC(2026, 8, 25, 3, 15, 0));
  });
});

describe("isStillLimited", () => {
  it("returns true when text contains a future reset", () => {
    assert.equal(isStillLimited("You hit your usage limit; resets at 2026-09-25T01:00:00Z", NOW), true);
  });

  it("returns false when text has no limit", () => {
    assert.equal(isStillLimited("Hello there", NOW), false);
  });

  it("returns true for ambiguous text without parsed time", () => {
    assert.equal(isStillLimited("You hit your usage limit", NOW), true);
  });
});

describe("detectCodexModel", () => {
  it("extracts a simple model name", () => {
    const text = "GPT-5.4 high · ~/.hermes/projects/foo · Context 91% used · 5h 21% left";
    assert.equal(detectCodexModel(text), "GPT-5.4");
  });

  it("extracts dotted model name", () => {
    const text = "GPT-5.6-sol high · /home/user/proj · 01a0d4d7 · Pursuing goal (39m)";
    assert.equal(detectCodexModel(text), "GPT-5.6-sol");
  });

  it("handles lowercase variant", () => {
    const text = "gpt-6-sol medium · somewhere";
    assert.equal(detectCodexModel(text), "gpt-6-sol");
  });

  it("returns null when no quality keyword is present", () => {
    assert.equal(detectCodexModel("Some random assistant output"), null);
  });

  it("returns null on empty input", () => {
    assert.equal(detectCodexModel(""), null);
  });
});

describe("isLikelyCodexModel", () => {
  it("rejects the Luna Reserve placeholder", () => {
    assert.equal(isLikelyCodexModel("GPT-Reserve"), false);
    assert.equal(isLikelyCodexModel("reserve"), false);
  });
  it("accepts real model names", () => {
    assert.equal(isLikelyCodexModel("GPT-5.4"), true);
    assert.equal(isLikelyCodexModel("GPT-5.6-sol"), true);
    assert.equal(isLikelyCodexModel("gpt-6-sol"), true);
  });
});
