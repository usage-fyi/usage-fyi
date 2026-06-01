---
id: T0002
slug: aggregate-and-stats
title: Aggregate PR events into per-project stats with percentiles
status: draft
priority: normal
complexity: M
plan: P001
source: designs/pr-creation-stats-from-conversation-logs-per-proje.md
source_item: null
key_files:
  - packages/cli/src/analyzers/aggregate.ts
  - packages/cli/src/analyzers/aggregate.test.ts
acceptance: |
  An `aggregate(events, sessionMetas)` function returns `byProject` keyed by
  canonical project path with `prCount`, `sessionCount`, `sessionsWithNoPR`,
  `medianMsToFirstPR`, and `p90MsToFirstPR`. `msToFirstPR` uses the earliest PR
  per session and is clamped to 0 on negative values (with a debug log). Tests
  cover the median/p90 math for small samples and confirm zero-PR sessions are
  counted but excluded from latency percentiles.
created: 2026-06-01
---

Implements [pr-creation-stats-from-conversation-logs-per-proje](.harness/docs/designs/pr-creation-stats-from-conversation-logs-per-proje.md).

Part of plan [P001](.harness/docs/plans/P001-pr-stats-analyzer.md).

## T5 — Aggregate PR events into per-project stats with percentiles

## Context

The scanners produce a flat list of session results. The aggregator joins them into `PREvent` records (one per PR, with timing fields) and computes per-project rollups including median and p90 of `msToFirstPR`. This is pure logic with no I/O and is the easiest piece to test exhaustively.

## Approach

Implement `packages/cli/src/analyzers/aggregate.ts`:

```typescript
export function aggregate(
  sessions: Array<{ result: ClaudeSessionResult | CodexSessionResult; source: PREvent["source"] }>,
  resolveProject: (cwd: string) => string,
): PRStatsReport {
  const events: PREvent[] = [];
  const sessionsByProject = new Map<string, { withPR: number; withoutPR: number; firstPRMs: number[] }>();
  // ... iterate, emit PREvent per rawPrEntry, compute msToFirstPR per session
}
```

Key rules:
- `msToFirstPR` is computed once per session (earliest `prTimestamp − sessionStart`) and pushed to the project's `firstPRMs` array. Subsequent PRs in the same session emit `PREvent` records but do not contribute additional `firstPRMs` samples.
- Negative deltas clamp to 0 (clock skew); log via `console.debug` once per occurrence.
- Sessions where `rawPrEntries.length === 0` increment `sessionsWithoutPR` for their project but contribute no events.

Percentile helper (linear interpolation, sorted ascending):

```typescript
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
```

Tests cover: a single-PR project (median = p90 = that value), three values (asserted median), seven values (asserted p90), a no-PR-only project (sessionsWithNoPR populated, latencies = 0).

## Notes

Do not sort `firstPRMs` in place on the map's stored array — sort a copy before percentile to keep the aggregator idempotent if a caller mutates inputs afterward.
