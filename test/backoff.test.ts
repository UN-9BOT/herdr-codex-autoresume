// Backoff tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { backoffSeconds, nextResetAfterFailure } from "../src/backoff.js";

describe("backoffSeconds", () => {
  it("uses the bounded ladder", () => {
    assert.equal(backoffSeconds(0, 300), 5);
    assert.equal(backoffSeconds(1, 300), 15);
    assert.equal(backoffSeconds(2, 300), 30);
    assert.equal(backoffSeconds(3, 300), 60);
    assert.equal(backoffSeconds(4, 300), 120);
  });

  it("caps at maxSeconds after the ladder", () => {
    assert.equal(backoffSeconds(99, 300), 300);
    assert.equal(backoffSeconds(99, 60), 60);
  });
});

describe("nextResetAfterFailure", () => {
  it("uses parsed reset when present and in future", () => {
    const now = 1_000_000;
    const result = nextResetAfterFailure(0, now + 30_000, now, 300);
    assert.equal(result, now + 30_000);
  });

  it("falls back to backoff when reset is missing", () => {
    const now = 1_000_000;
    assert.equal(nextResetAfterFailure(0, undefined, now, 300), now + 5_000);
    assert.equal(nextResetAfterFailure(1, undefined, now, 300), now + 15_000);
  });

  it("uses backoff when reset is already in the past", () => {
    const now = 1_000_000;
    assert.equal(nextResetAfterFailure(2, now - 1, now, 300), now + 30_000);
  });
});
