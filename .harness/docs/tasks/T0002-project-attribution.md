---
id: T0002
slug: project-attribution
title: Add cwd → git-root project resolver with caching
status: draft
priority: normal
complexity: S
plan: P001
source: designs/pr-creation-stats-from-conversation-logs-per-proje.md
source_item: null
key_files:
  - packages/cli/src/analyzers/projectResolver.ts
  - packages/cli/src/analyzers/projectResolver.test.ts
acceptance: |
  `resolveProject(cwd, { gitRootResolver })` normalizes paths (resolve symlinks,
  trim trailing slash), then resolves to git root via the injected resolver. A
  memoized cache ensures only one call per unique input cwd. Worktree paths
  collapse to their parent repo root. Tests inject a fake resolver and assert
  cache hit behavior plus correct collapsing for at least one worktree-style
  path.
created: 2026-06-01
---

Implements [pr-creation-stats-from-conversation-logs-per-proje](.harness/docs/designs/pr-creation-stats-from-conversation-logs-per-proje.md).

Part of plan [P001](.harness/docs/plans/P001-pr-stats-analyzer.md).

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
