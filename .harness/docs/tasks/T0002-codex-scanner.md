---
id: T0002
slug: codex-scanner
title: Implement Codex scanner with grep-based PR URL detection
status: draft
priority: normal
complexity: M
plan: P001
source: designs/pr-creation-stats-from-conversation-logs-per-proje.md
source_item: null
key_files:
  - packages/cli/src/analyzers/sources/codex.ts
  - packages/cli/src/analyzers/sources/codex.test.ts
  - packages/cli/src/analyzers/__fixtures__/codex-single-pr.jsonl
acceptance: |
  A `scanCodexSession(filePath)` function streams the rollout JSONL, extracts
  `cwd` from the first `session_meta` entry, and applies the
  `https://github\.com/[^/\s]+/[^/\s]+/pull/[0-9]+` regex to
  `response_item.payload.output` text only (anchored to line start after optional
  whitespace). Matching events use the enclosing `response_item.timestamp`. Test
  fixture verifies one PR is detected and that URLs appearing only in
  message-content fields are ignored.
created: 2026-06-01
---

Implements [pr-creation-stats-from-conversation-logs-per-proje](.harness/docs/designs/pr-creation-stats-from-conversation-logs-per-proje.md).

Part of plan [P001](.harness/docs/plans/P001-pr-stats-analyzer.md).

## T3 — Implement Codex scanner with grep-based PR URL detection

## Context

Codex has no structured `pr-link` type, so PR URLs must be extracted via regex from `response_item.payload.output` (the `gh pr create` tool result). Restricting the scan to tool-output fields and anchoring to line-start avoids false positives from URLs quoted in user prompts or assistant messages.

## Approach

Implement `scanCodexSession(filePath: string): Promise<CodexSessionResult>` in `packages/cli/src/analyzers/sources/codex.ts`. Stream the JSONL the same way as the Claude scanner. Track:

- `cwd`: from the first `entry.type === "session_meta"` entry's `payload.cwd`.
- `sessionStart`/`sessionEnd`: min/max of top-level `entry.timestamp`.
- For each `entry.type === "response_item"` where `entry.payload?.type === "function_call_output"`, scan `entry.payload.output` (a string) line-by-line with:

```typescript
const PR_URL_RE = /^\s*(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+))\b/m;
```

For each match, parse `owner/repo` out of the URL path and emit a raw PR entry with `entry.timestamp`. Deduplicate by URL within the session.

Skip any `response_item` whose payload type is not `function_call_output` — message and reasoning items must not be scanned.

Fixture `codex-single-pr.jsonl`:
- one `session_meta` line with `payload.cwd`.
- one `response_item` of type `message` whose content happens to contain a fake PR URL → must NOT match.
- one `response_item` of type `function_call_output` whose `output` starts with `https://github.com/foo/bar/pull/42` → must match.

## Notes

Codex's `~/.codex/session_index.jsonl` is listed as an open question for date pre-filtering — explicitly do not use it in this task. The session file path is also unstable across `gh` versions; rely on the regex only, not surrounding shell output framing.
