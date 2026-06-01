---
id: T0002
slug: claude-code-scanner
title: Implement Claude Code JSONL scanner with pr-link detection
status: draft
priority: normal
complexity: M
plan: P001
source: designs/pr-creation-stats-from-conversation-logs-per-proje.md
source_item: null
key_files:
  - packages/cli/src/analyzers/sources/claudeCode.ts
  - packages/cli/src/analyzers/sources/claudeCode.test.ts
  - packages/cli/src/analyzers/__fixtures__/claude-code-single-pr.jsonl
  - packages/cli/src/analyzers/__fixtures__/claude-code-multi-pr.jsonl
  - packages/cli/src/analyzers/__fixtures__/claude-code-no-pr.jsonl
acceptance: |
  A `scanClaudeCodeSession(filePath)` function streams a JSONL file line-by-line
  and returns `{ sessionStart, sessionEnd, prEvents[], cwd, sessionId }`. PR events
  come exclusively from `type === "pr-link"` entries; deduplicated by `prUrl` within
  the session. Timestamps are computed via min/max across all entries that carry a
  `timestamp`. Vitest fixtures cover single-PR, multi-PR (with duplicate), and
  no-PR cases; tests pass.
created: 2026-06-01
---

Implements [pr-creation-stats-from-conversation-logs-per-proje](.harness/docs/designs/pr-creation-stats-from-conversation-logs-per-proje.md).

Part of plan [P001](.harness/docs/plans/P001-pr-stats-analyzer.md).

## T2 — Implement Claude Code JSONL scanner with pr-link detection

## Context

Claude Code is the primary source and is fully structured: the `pr-link` entry carries every field needed (`prUrl`, `prNumber`, `prRepository`, `sessionId`, `timestamp`). No regex or content scanning is required, which means zero false-positive risk.

## Approach

Implement `scanClaudeCodeSession(filePath: string): Promise<ClaudeSessionResult>` in `packages/cli/src/analyzers/sources/claudeCode.ts`. Stream the file with `readline` over a `fs.createReadStream`, parsing each line as JSON. Track:

- `sessionStart`/`sessionEnd`: running min/max of `entry.timestamp` (skip entries missing it).
- `cwd`: first non-null `entry.cwd` encountered.
- `sessionId`: derived from `pr-link.sessionId` or the file basename.
- `prEvents`: collected from `entry.type === "pr-link"`, deduplicated by `prUrl` using a `Set`.

Return shape:

```typescript
interface ClaudeSessionResult {
  filePath: string;
  sessionId: string | null;
  cwd: string | null;
  sessionStart: string | null;
  sessionEnd: string | null;
  rawPrEntries: Array<{ prUrl: string; prNumber: number; prRepository: string; timestamp: string; sessionId: string }>;
}
```

Fixtures:
- `claude-code-single-pr.jsonl`: one `user`, one `assistant`, one `pr-link`.
- `claude-code-multi-pr.jsonl`: two distinct `pr-link` entries + one duplicate of the first.
- `claude-code-no-pr.jsonl`: only `user`/`assistant`/`attachment` entries.

## Notes

Use a try/catch around `JSON.parse` per line — malformed lines are skipped silently, not thrown. Warn (debug-level only) if more than 50% of entries lack `timestamp`. Never load message content into memory; only read the fields enumerated above.
