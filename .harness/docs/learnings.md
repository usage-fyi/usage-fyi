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
