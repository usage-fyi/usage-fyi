---
status: waiting
complexity: L
source: .harness/docs/raw-tasks.md
source_item: line 1
---

# PR creation stats from conversation logs (per-project, time-to-PR)

## Problem

Users want to measure their PR-creation throughput: how many PRs they create per project and how long each takes from session start to PR submission. The input is the local LLM conversation logs already on-disk. Hard constraint: no conversation content may be sent to any LLM or external service — detection is grep-like, not LLM-assisted.

## Data sources

### Claude Code (primary)

Session files: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`

Path encoding: the absolute CWD with every `/` replaced by `-` (leading slash included).
Example: `/Users/alice/work/myrepo` → `-Users-alice-work-myrepo`.

Format: newline-delimited JSON. Confirmed entry types and fields:

- `user` / `assistant` / `attachment`: carry `timestamp` (ISO 8601) and `cwd` fields.
- `pr-link` (key signal): a structured record emitted by Claude Code at PR creation:

```json
{
  "type": "pr-link",
  "sessionId": "<uuid>",
  "prNumber": 419,
  "prUrl": "https://github.com/owner/repo/pull/419",
  "prRepository": "owner/repo",
  "timestamp": "2026-05-28T05:56:11.425Z"
}
```

Session start: `min(timestamp)` across all entries that carry a `timestamp`.
Session end: `max(timestamp)` across all entries.
Project: `cwd` field present on most `user`, `assistant`, and `attachment` entries.

### Codex (secondary)

Session files: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`

Format: `{"timestamp":"...","type":"...","payload":{...}}`.
Key types: `session_meta` (first entry, has `cwd`), `response_item` (has tool output).

PR detection: no structured `pr-link` type. PR URL appears inside a `response_item` entry
of sub-type `function_call_output` whose `output` text contains the `gh pr create` result.
Grep `response_item.payload.output` for `https://github\.com/[^/\s]+/[^/\s]+/pull/[0-9]+`.
Timestamp: top-level `timestamp` on the matching `response_item`.

Project: `session_meta.payload.cwd`.

### Gemini CLI (tertiary)

Session files: `~/.gemini/tmp/<project-name>/chats/<session-id>.jsonl`

Project mapping: `~/.gemini/projects.json` → `{ "<abs-cwd>": "<project-name>" }`.
Each `~/.gemini/tmp/<project-name>/` also has a `.project_root` file with the absolute CWD.

First JSONL line: session metadata including `sessionId` and `startTime`.

⚠ Tool-output field structure for Gemini CLI **not verified on-machine** — must be confirmed
during implementation before enabling Gemini support. Grep approach is the same: scan tool
output fields only for the GitHub PR URL pattern. Skip message-content fields to avoid
false positives from quoted URLs in prompts.

## Detection logic

**Primary (Claude Code):** scan for `"type": "pr-link"` entries. Fully structured; no
text-parsing or false positives.

**Secondary (Codex/Gemini):** apply the pattern
`https://github\.com/[^/\s]+/[^/\s]+/pull/[0-9]+` to tool-output fields only:
- Codex: `response_item.payload.output`
- Gemini: equivalent tool-output field (TBD)

Restrict to tool-output fields — scanning message content would match quoted URLs in
prompts, code, or documentation. Require the matched URL to appear at the start of a line
(after optional whitespace) to further reduce false positives.

**Project attribution:**
1. Read `cwd` from the session entry.
2. Resolve to git root via `git -C <cwd> rev-parse --show-toplevel` (inject as a
   function parameter for testability; one call per unique CWD, cached).
3. Normalize path (resolve symlinks, trim trailing slash).
4. Worktree paths (e.g. `.harness/worktrees/iter-N`) collapse to the parent repo root via
   git-root resolution.

## Metrics & timing model

For each session containing ≥ 1 PR event:

| Field | Definition |
|---|---|
| `sessionStart` | `min(timestamp)` across all entries in the file |
| `sessionEnd` | `max(timestamp)` across all entries |
| `prTimestamp` | `timestamp` on the `pr-link` entry (or matching `response_item`) |
| `msToFirstPR` | `prTimestamp₀ − sessionStart` |
| `msSessionTotal` | `sessionEnd − sessionStart` |

Multiple PRs per session: each `pr-link` yields a separate `PREvent`. Deduplicate by
`prUrl` within a session (same PR URL appearing multiple times → count once).

Sessions with zero PR events: counted in `sessionsWithNoPR`; not included in latency stats.

## Output schema & integration

This feature is **not** a `UsageAdapter` — it produces no token metrics and does not extend
`Snapshot`. It is a standalone analyzer: `packages/cli/src/analyzers/prStats.ts`.

```typescript
interface PREvent {
  prUrl: string;         // https://github.com/owner/repo/pull/n
  prRepository: string;  // owner/repo
  prNumber: number;
  sessionId: string;
  project: string;       // canonical git root path
  source: "claude-code" | "codex" | "gemini";
  sessionStart: string;  // ISO 8601
  prTimestamp: string;   // ISO 8601
  sessionEnd: string;    // ISO 8601
  msToFirstPR: number;
  msSessionTotal: number;
}

interface PRProjectStats {
  prCount: number;
  sessionCount: number;       // sessions with ≥ 1 PR
  sessionsWithNoPR: number;
  medianMsToFirstPR: number;
  p90MsToFirstPR: number;
}

interface PRStatsReport {
  schema: "pr-stats/1";
  generatedAt: string;
  events: PREvent[];
  byProject: Record<string, PRProjectStats>;
}
```

**CLI integration:** new subcommand `usage-fyi pr-stats`. With `--json`: emit
`PRStatsReport` to stdout. Without `--json`: print a human-readable table (project,
PR count, median time-to-PR, p90). No network call; no publishing to usage.fyi in v1.

**No changes to `Snapshot`, `packages/wire/`, or existing adapters.**

## Privacy guarantees

The analyzer reads only structural fields: `type`, `timestamp`, `cwd`, `prUrl`,
`prNumber`, `prRepository`. It does not read, store, or transmit message text, tool
arguments, thinking blocks, or any free-form content. The only data retained is the PR
URL (a public GitHub link), timestamps, and project path. Nothing leaves the local machine.

## Edge cases & risks

| Scenario | Handling |
|---|---|
| Duplicate `pr-link` entries (same PR, same session) | Deduplicate by `prUrl` within session |
| `msSessionTotal` inflated by laptop sleep | Document; add optional `--max-session-minutes` cap |
| Missing `timestamp` on some entries | Skip for timing; warn if < 50 % of entries lack timestamps |
| Multi-cwd session (cwd changes mid-session) | Use first `cwd` seen; note as open question |
| Very large log corpus | Stream-parse JSONL line-by-line; never load full file into memory |
| Clock skew / negative `msToFirstPR` | Clamp to 0; log a debug warning |
| Codex URL in non-output field | Skip — restrict scanning to tool-output fields only |
| Gemini CLI format unconfirmed | Gemini support ships as best-effort after format is verified |
| Draft / closed PRs | Not distinguishable from JSONL; all PR URLs counted equally (open Q) |

## Testing strategy

Vitest unit tests: `packages/cli/src/analyzers/prStats.test.ts`.
Fixture files under `packages/cli/src/analyzers/__fixtures__/`:
- `claude-code-single-pr.jsonl` — session with one `pr-link`
- `claude-code-multi-pr.jsonl` — two `pr-link` events (same and different PRs)
- `claude-code-no-pr.jsonl` — session with no `pr-link`
- `codex-single-pr.jsonl` — `function_call_output` containing a PR URL

Assertions: correct `PREvent` extraction, correct `msToFirstPR`, deduplication, aggregate
counts and percentiles. `gitRootResolver` injected as a parameter so tests run without
spawning `git`.

## Open questions

1. **Draft PRs**: no signal in JSONL to distinguish draft from regular PRs. Count all, or
   add a CLI flag to filter by querying the GitHub API?
2. **Multi-cwd sessions**: harness worktrees change `cwd` mid-session; what is the
   canonical project? First `cwd`? Git root of the entry where the PR link appears?
3. **Gemini CLI tool-output schema**: must be confirmed on-machine before implementing
   the Gemini scanner.
4. **Publish integration**: should `PRStatsReport` eventually be publishable to usage.fyi?
   Requires a new wire schema definition and server-side support.
5. **Date-range filter**: should the analyzer accept `--since`/`--until` flags aligned
   with `CollectOpts` to limit which session files are scanned?
6. **Codex session_index**: `~/.codex/session_index.jsonl` exists — can it pre-filter
   sessions by date before opening each file?
