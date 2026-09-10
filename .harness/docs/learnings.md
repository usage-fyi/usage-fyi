# Harness Learnings

Reusable, non-obvious facts discovered during iterations — things a future agent would otherwise have to rediscover.

---

## 2026-06-01 — T0001: PR-creation stats design

### Claude Code JSONL session format

- **Location**: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
- **Path encoding**: Absolute CWD with every `/` replaced by `-` (leading `/` becomes leading `-`). Example: `/Users/alice/work/myrepo` → `-Users-alice-work-myrepo`.
- **Structured `pr-link` entries**: Claude Code emits a dedicated entry type at PR creation time — no text parsing needed:
  ```json
  { "type": "pr-link", "sessionId": "...", "prNumber": 419,
    "prUrl": "https://github.com/owner/repo/pull/419",
    "prRepository": "owner/repo", "timestamp": "2026-05-28T05:56:11.425Z" }
  ```
  This is the most reliable signal — appears before and after the corresponding Bash tool_result.
- **Timestamps**: Most `user`, `assistant`, and `attachment` entries carry a top-level `timestamp` (ISO 8601). `last-prompt`, `mode`, and `permission-mode` entries do NOT.
- **`cwd` field**: Present on most `user`, `assistant`, and `attachment` entries.

### Codex JSONL session format

- **Location**: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`
- **Format**: `{"timestamp":"...","type":"...","payload":{...}}` per line.
- **Session metadata**: First entry is `type: session_meta` with `payload.cwd` and session start time.
- **PR detection**: No `pr-link` type. PR URL appears in `response_item` entries whose `payload` has `type: function_call_output` and `output` containing the `gh pr create` stdout (the URL line).
- **Session index**: `~/.codex/session_index.jsonl` lists sessions with id, thread_name, updated_at — potentially usable to pre-filter by date.

### Gemini CLI session format

- **Location**: `~/.gemini/tmp/<project-name>/chats/<session-id>.jsonl`
- **Project mapping**: `~/.gemini/projects.json` → `{ "<absolute-cwd>": "<project-name>" }`. Also `.project_root` files in each project subdir.
- **First JSONL line**: session metadata with `sessionId`, `startTime`, `lastUpdated`, `kind`.
- **Tool-output structure**: Not fully verified — PR URL detection approach TBD.

### harness plan generate behaviour (design gate)

- `harness plan generate <slug>` auto-promotes the design to `status: approved` and sets `approved_by: plan-generate` even when `AUTO_APPROVE_DESIGN_COMPLEXITY=none`. The "next: harness design approve ..." message in the output is shown as a fallback hint but is pre-empted by the generate call itself.
- The generated task files all received the same task ID (`T0002`) when 6 tasks were created — there may be an ID-allocation bug when plan generate creates multiple tasks in one shot.

### Worktree git topology

- Worktrees live inside `.harness/worktrees/<name>/` which is within the main repo's working tree. Files in `.harness/docs/` are outside the worktree directory and cannot be staged with a plain `git add` from within the worktree.
- Workaround: set `GIT_DIR=<main-repo>/.git/worktrees/<name>` and `GIT_WORK_TREE=<main-repo>` when running git commands from the main repo directory — this allows staging `.harness/docs/` files onto the worktree's branch.

### `git rev-parse` for canonical project root — use `--git-common-dir`, not `--show-toplevel`

- `git rev-parse --show-toplevel` returns the **worktree's own** top-level directory for linked worktrees (e.g. `.harness/worktrees/iter-N`, `.claude/worktrees/agent-X`). This causes every linked worktree to be attributed as a separate project.
- The correct approach: resolve via `git rev-parse --git-common-dir` (returns the shared `.git` dir for the main repo, identical across all linked worktrees), then take its parent as the canonical project root.
- Fall back to `--show-toplevel` when the common-dir path is not a plain `.git` directory (bare repos, `--separate-git-dir`, submodule gitfiles).
- On real local data, using `--show-toplevel` inflated the project count from 8 to 44 with dozens of zero-PR worktree rows.

### `console.debug` in Node.js routes to stdout, not stderr

- `console.debug(...)` is an alias for `console.log` in Node.js — it writes to **stdout**, not stderr.
- Any diagnostic/warning emitted via `console.debug` will contaminate `--json` output, making it invalid JSON that consumers can't `JSON.parse`.
- Always use `console.error(...)` for warnings and diagnostics that must stay out of the machine-readable stdout stream.

## 2026-06-02 — T0010: ccusage pricing adapter

### `exactOptionalPropertyTypes: true` requires conditional spreads for optional fields

- TypeScript with `exactOptionalPropertyTypes: true` disallows assigning `undefined` to optional properties (e.g. `pricingFlag: undefined` on `pricingFlag?: "a" | "b"`).
- Use conditional spreads: `...(val !== undefined ? { pricingFlag: val } : {})` when populating optional fields from values that may be undefined.

### Pricing adapter: keep IO and computation separate for testability

- The memoized subprocess call (`loadPricingFn`) returns a **synchronous** `SyncPricingFn`, isolating the async subprocess from the pure aggregation functions.
- Export `buildRateMap` and `makePricingFn` as pure functions so tests can feed synthetic fixture data without spawning a subprocess.
- Pass the `SyncPricingFn` into `windowSession` / `aggregateTokensByProject` as an optional parameter — keeps the aggregator pure and testable without IO.

### Multi-model windows: average-rate approximation

- PR windows may contain events from multiple models (e.g. claude-opus + claude-haiku in the same window) but `TokenBreakdown` aggregates all tokens without per-model split.
- Approach: call the pricing fn for each model with the full window's `totalTokens`, then average the USD results. Documents this as "blended-rate" via the pricing flag.
- Single-model windows (common case) are exact; multi-model windows are an equal-split approximation — documented in code.

## 2026-06-03 — T0013: Hand-built fixtures plus ccusage reconciliation test

### Fixture-based testing with dual-scanner directories

- `analyzePRStats` accepts `claudeProjectsDir` and `codexSessionsDir`. When both point to the same directory, ALL JSONL files are scanned by BOTH scanners.
- Codex-format files scanned by the Claude scanner: `session_meta` sets `cwd` and timestamps come from `event_msg`/`response_item` entries (because the Claude scanner processes ALL lines' timestamps). This produces a valid-but-0-token session that passes the `cwd && sessionStart` guard.
- Claude-format files scanned by the Codex scanner: no `session_meta` → `cwd=null` → skipped by `analyzePRStats`. Safe.
- Net effect: pointing both scanners at the same fixture directory adds one extra 0-token session per codex-format file. Token totals are unaffected.

### `windowSession` session-only trigger requires null `tsMs`

- The post-sort monotonicity check (`sortedTokens[i].tsMs < sortedTokens[i-1].tsMs`) is unreachable in practice after a valid numeric sort.
- The only reliable way to trigger `session-only` attribution in fixtures is an unparseable timestamp string (e.g., `"2026-13-10T..."` with invalid month 13). `parseTs` returns `null` for non-finite `getTime()` results, which then triggers the `tokensWithMs.some(t => t.tsMs === null)` guard.
- Corrupt timestamps are counted in `sessionBreakdown` (computed before the guard check), so `session.tokens.totalTokens` still reflects the full session spend even in session-only mode.

### String comparison for sessionStart/sessionEnd in Claude scanner

- The Claude scanner uses lexicographic string comparison (`record.timestamp < sessionStart`) to track min/max timestamps. ISO 8601 sorts lexicographically, so this is correct for valid dates.
- Pathological timestamps (e.g., `"INVALID"`, `"2026-13-..."`) may "win" the comparison if their leading characters sort after `'2'` (ASCII 50). This can cause `sessionEnd` to be set to an invalid string.
- In `windowSession`, `parseTs(sessionEnd)` returns `null` → `endMs=null` → `durationMs=0`. No crash, but `durationMs` is 0 and `tokensPerActiveMinute` is null for affected sessions.
