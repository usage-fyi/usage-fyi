---
id: T0002
slug: scaffold-analyzer-module
title: Scaffold prStats analyzer module with shared types
status: draft
priority: normal
complexity: S
plan: P001
source: designs/pr-creation-stats-from-conversation-logs-per-proje.md
source_item: null
key_files:
  - packages/cli/src/analyzers/prStats.ts
  - packages/cli/src/analyzers/types.ts
acceptance: |
  A new `packages/cli/src/analyzers/` directory exists with `prStats.ts` exporting
  `PREvent`, `PRProjectStats`, `PRStatsReport` interfaces matching the design doc
  verbatim, plus a top-level `analyzePRStats(opts)` function stub that returns an
  empty `PRStatsReport`. The file compiles under the package's existing tsconfig
  and is wired into the package barrel if one exists. No runtime behavior yet.
created: 2026-06-01
---

Implements [pr-creation-stats-from-conversation-logs-per-proje](.harness/docs/designs/pr-creation-stats-from-conversation-logs-per-proje.md).

Part of plan [P001](.harness/docs/plans/P001-pr-stats-analyzer.md).

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
