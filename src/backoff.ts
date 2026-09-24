// Bounded exponential backoff for resume retries.
//
// The schedule is 5s, 15s, 30s, 60s, 120s, then capped at `maxSeconds`.
// Once `maxSeconds` is reached the schedule stays at the cap rather than
// growing further.

const DEFAULT_LADDER_SECONDS = [5, 15, 30, 60, 120];

export function backoffSeconds(attempts: number, maxSeconds: number): number {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) return 120;
  const ladder = DEFAULT_LADDER_SECONDS.map((s) => Math.min(s, maxSeconds));
  if (attempts < ladder.length) {
    const v = ladder[attempts];
    if (typeof v === "number") return Math.min(v, maxSeconds);
  }
  return maxSeconds;
}

export function nextResetAfterFailure(
  attempts: number,
  detectedResetMs: number | undefined,
  nowMs: number,
  maxSeconds: number,
): number {
  if (typeof detectedResetMs === "number" && detectedResetMs > nowMs) {
    return detectedResetMs;
  }
  return nowMs + backoffSeconds(attempts, maxSeconds) * 1000;
}
