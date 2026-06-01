---
id: T0002
slug: cli-subcommand
title: "Wire `usage-fyi pr-stats` subcommand with --json and table output"
status: draft
priority: normal
complexity: M
plan: P001
source: designs/pr-creation-stats-from-conversation-logs-per-proje.md
source_item: null
key_files:
  - packages/cli/src/commands/prStats.ts
  - packages/cli/src/index.ts
  - packages/cli/src/commands/prStats.test.ts
acceptance: |
  A new `pr-stats` subcommand is registered in the CLI entrypoint. It discovers
  Claude Code and Codex session files under their default home-dir paths, runs
  the scanners + aggregator, and prints either a JSON `PRStatsReport`
  (`--json`) or a human-readable table (project, PR count, median time-to-PR,
  p90). No network calls; exits 0 even when zero events are found.
created: 2026-06-01
---

Implements [pr-creation-stats-from-conversation-logs-per-proje](.harness/docs/designs/pr-creation-stats-from-conversation-logs-per-proje.md).

Part of plan [P001](.harness/docs/plans/P001-pr-stats-analyzer.md).

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
