---
id: P001
slug: pr-stats-analyzer
status: waiting
complexity: L
created: 2026-06-01
approved: null
approved_by: null
design: pr-creation-stats-from-conversation-logs-per-proje
tasks:
  - id: T0002
    title: Scaffold prStats analyzer module with shared types
  - id: T0002
    title: Implement Claude Code JSONL scanner with pr-link detection
  - id: T0002
    title: Implement Codex scanner with grep-based PR URL detection
  - id: T0002
    title: Add cwd → git-root project resolver with caching
  - id: T0002
    title: Aggregate PR events into per-project stats with percentiles
  - id: T0002
    title: "Wire `usage-fyi pr-stats` subcommand with --json and table output"
---

# Plan: PR creation stats from conversation logs (per-project, time-to-PR)

Generated from design [pr-creation-stats-from-conversation-logs-per-proje](.harness/docs/designs/pr-creation-stats-from-conversation-logs-per-proje.md).

Tasks: `T0002`, `T0002`, `T0002`, `T0002`, `T0002`, `T0002`.

## Goal

Deliver a standalone, privacy-preserving `usage-fyi pr-stats` analyzer that reads local Claude Code and Codex conversation logs on-disk, detects PR-creation events using structural fields and a narrow regex against tool-output fields only, and reports per-project PR counts plus median/p90 time-to-first-PR. The analyzer does not extend `Snapshot`, does not touch `packages/wire/`, and emits no network traffic — its only output is local stdout (JSON or table).

## Approach

We split the work along source/transform/output seams so each piece is independently testable. The scaffold task lands the shared TypeScript types from the design verbatim and a stub entrypoint, giving every subsequent task a stable import surface. The two scanners (Claude Code and Codex) are then implemented in parallel-friendly files under `analyzers/sources/`, each exposing the same shape: stream a single JSONL file and return `{ sessionStart, sessionEnd, prEvents[], cwd, sessionId }`. Streaming (not whole-file reads) is mandatory for the large-corpus edge case.

Project attribution is a separate utility because both scanners need it and it carries the only out-of-process call in the whole feature (`git rev-parse --show-toplevel`). Injecting `gitRootResolver` as a parameter keeps the unit tests hermetic. The aggregator is pure: it takes the union of scanner outputs and produces `PRProjectStats`. The CLI subcommand is the only piece that performs filesystem discovery and process I/O; keeping it thin means the analyzer's logic is reusable if a future task wants to publish or chart these stats.

Gemini CLI support is deliberately deferred — its tool-output schema is unverified and would block the rest. The Open Questions (date filters, draft-PR distinction, multi-cwd canonical, publish integration) are also out of scope for v1.

## Out of scope

- Gemini CLI scanner (tool-output field structure unconfirmed).
- Publishing `PRStatsReport` to usage.fyi or extending `packages/wire/`.
- `--since`/`--until` date filters and `--max-session-minutes` sleep-cap flag.
- GitHub API calls to classify draft vs. open vs. closed PRs.
- Multi-cwd canonicalization beyond "first cwd seen".

## T1 — Scaffold prStats analyzer module with shared types

## T1 — Scaffold prStats analyzer module with shared types

## Context

Every later task imports `PREvent`, `PRProjectStats`, and `PRStatsReport`. Landing the types and a no-op entrypoint first lets the scanner and aggregator tasks proceed in parallel without import churn or merge conflicts on a shared types file.

## Approach

Create `packages/cli/src/analyzers/prStats.ts` with the three interfaces copied verbatim from the design doc, plus an `analyzePRStats(opts: AnalyzePRStatsOpts): Promise<PRStatsReport>` stub:

```typescript
export interface AnalyzePRStatsOpts {
  claudeProjectsDir?: string;  // default: ~/.claude/projects
  codexSessionsDir?: string;   // default: ~/.codex/sessions
  gitRootResolver?: (cwd: string) => string | null;
}

export async function analyzePRStats(_opts: AnalyzePRStatsOpts = {}): Promise<PRStatsReport> {
  return {
    schema: "pr-stats/1",
    generatedAt: new Date().toISOString(),
    events: [],
    byProject: {},
  };
}
```

Check whether `packages/cli/src/` has a barrel `index.ts` and add an export only if one already exists — do not create one. Verify the package's tsconfig picks up the new directory (it should, since the glob is typically `src/**/*.ts`).

## Notes

No tests in this task — the stub is exercised by later tasks. Keep `schema: "pr-stats/1"` as a string literal type so future consumers can narrow on it.

## T2 — Implement Claude Code JSONL scanner with pr-link detection

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

## T3 — Implement Codex scanner with grep-based PR URL detection

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

## T4 — Add cwd → git-root project resolver with caching

## T4 — Add cwd → git-root project resolver with caching

## Context

Both scanners emit `cwd` strings, but harness worktrees (`.harness/worktrees/iter-N`) and symlinked checkouts must collapse to a single canonical project. Shelling out for `git rev-parse --show-toplevel` once per unique cwd is fine; once per session entry would dominate runtime.

## Approach

Implement `packages/cli/src/analyzers/projectResolver.ts`:

```typescript
export type GitRootResolver = (cwd: string) => string | null;

export function createProjectResolver(gitRootResolver: GitRootResolver) {
  const cache = new Map<string, string>();
  return function resolveProject(cwd: string): string {
    const normalized = path.resolve(cwd).replace(/\/+$/, "");
    const cached = cache.get(normalized);
    if (cached) return cached;
    const root = gitRootResolver(normalized) ?? normalized;
    const canonical = fs.realpathSync.native?.(root) ?? root;
    cache.set(normalized, canonical);
    return canonical;
  };
}
```

A default `gitRootResolver` (in the same file but exported separately) shells out to `git -C <cwd> rev-parse --show-toplevel` via `execFileSync` and returns `null` on non-zero exit. Tests inject a stub map: `{ "/a/.harness/worktrees/iter-1": "/a" }` and assert the cache is consulted on the second call.

## Notes

`fs.realpathSync` can throw on missing paths — fall back to the raw root if it does. Do not use `realpath` on the *cwd* input itself, only on the resolved git root, to avoid masking the "missing directory" case as a different project.

## T5 — Aggregate PR events into per-project stats with percentiles

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

## T6 — Wire `usage-fyi pr-stats` subcommand with --json and table output

## T6 — Wire `usage-fyi pr-stats` subcommand with --json and table output

## Context

This is the only task with filesystem discovery and process I/O. It glues the scanners, resolver, and aggregator behind a single CLI verb and provides both machine- and human-readable output.

## Approach

Add `packages/cli/src/commands/prStats.ts` exporting a `registerPrStats(program)` function (or whatever pattern the existing CLI uses — check `index.ts` and mirror the existing subcommand registration style). Inspect a sibling command like `publish` first to match argument-parsing conventions.

Steps inside the command handler:

1. Resolve session directories from `os.homedir()`: `~/.claude/projects` and `~/.codex/sessions`.
2. Glob `*.jsonl` recursively under each (use Node's `fs.promises.readdir` with `{ recursive: true }` — available on the engines this repo targets).
3. For each Claude file, call `scanClaudeCodeSession`. For each Codex file, call `scanCodexSession`. Skip files that throw, with a stderr warning.
4. Build the project resolver with the default `gitRootResolver`. Run `aggregate(...)`.
5. If `--json`: `process.stdout.write(JSON.stringify(report, null, 2) + "\n")`. Otherwise print a fixed-width table:

```
PROJECT                           PRs   median   p90
/Users/alice/work/myrepo           12   8m 14s   23m 02s
```

Format durations with a small `formatMs(ms)` helper (m/s for < 1h, h/m otherwise). Exit 0 even when `events.length === 0` — print "No PR events found." to stderr in that case (table mode only).

Test: smoke-test the command with two fake home dirs (point `claudeProjectsDir`/`codexSessionsDir` at fixtures) and assert the JSON output schema field equals `"pr-stats/1"` and contains the expected `byProject` keys.

## Notes

Do not import `git` resolution at module load time — defer to the handler so `--help` stays fast. If the existing CLI uses commander/yargs, follow that lib's idioms; if it's hand-rolled, keep the subcommand registration minimal and consistent.
