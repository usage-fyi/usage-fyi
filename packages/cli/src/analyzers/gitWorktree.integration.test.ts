import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultGitRootResolver,
  resolveProject,
  clearResolveProjectCache,
} from "./index.js";

const execFileAsync = promisify(execFile);

/**
 * Integration coverage for the worktree-collapse behaviour, exercising the
 * REAL `defaultGitRootResolver` against an actual git worktree.
 *
 * Regression guard: a linked worktree (e.g. `.harness/worktrees/iter-N`) must
 * collapse to the main repo root, not appear as its own project. Earlier unit
 * tests only fed a synthetic `.git/worktrees/…` path to a fake resolver, which
 * the real resolver never emits — so the broken default slipped through.
 */
describe("git worktree collapse (integration)", () => {
  let root: string;
  let mainRepo: string;
  let mainRepoReal: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileAsync("git", args, { cwd });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pr-stats-wt-"));
    mainRepo = join(root, "main");
    await mkdir(mainRepo, { recursive: true });

    await git(mainRepo, "init", "-q");
    await git(mainRepo, "config", "user.email", "test@example.com");
    await git(mainRepo, "config", "user.name", "Test");
    // A worktree can only be added once the repo has a commit / HEAD.
    await git(mainRepo, "commit", "--allow-empty", "-q", "-m", "init");

    // realpath because macOS tmpdir is a symlink (/var → /private/var) and git
    // returns the fully-resolved path.
    mainRepoReal = await realpath(mainRepo);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    clearResolveProjectCache();
  });

  it("collapses a nested linked worktree to the main repo root", async () => {
    // Mirror the real layout: a worktree living *inside* the main repo, like
    // `.harness/worktrees/iter-N`.
    const worktree = join(mainRepo, ".harness", "worktrees", "iter-1");
    await git(mainRepo, "worktree", "add", "-q", "-b", "iter-1", worktree);

    const resolved = await defaultGitRootResolver(worktree);
    expect(resolved).toBe(mainRepoReal);
  });

  it("collapses an external linked worktree to the main repo root", async () => {
    const worktree = join(root, "external-wt");
    await git(mainRepo, "worktree", "add", "-q", "-b", "external", worktree);

    const resolved = await defaultGitRootResolver(worktree);
    expect(resolved).toBe(mainRepoReal);
  });

  it("returns the repo root for the main worktree itself", async () => {
    const resolved = await defaultGitRootResolver(mainRepo);
    expect(resolved).toBe(mainRepoReal);
  });

  it("returns null for a directory that is not a git repo", async () => {
    const notRepo = join(root, "not-a-repo");
    await mkdir(notRepo, { recursive: true });
    const resolved = await defaultGitRootResolver(notRepo);
    expect(resolved).toBeNull();
  });

  it("resolveProject maps both main and worktree cwds to one canonical project", async () => {
    clearResolveProjectCache();
    const worktree = join(mainRepo, ".harness", "worktrees", "iter-2");
    await git(mainRepo, "worktree", "add", "-q", "-b", "iter-2", worktree);

    const fromMain = await resolveProject(mainRepo, {
      gitRootResolver: defaultGitRootResolver,
    });
    const fromWorktree = await resolveProject(worktree, {
      gitRootResolver: defaultGitRootResolver,
    });

    expect(fromMain?.gitRoot).toBe(mainRepoReal);
    // The whole point: the worktree must NOT be its own project.
    expect(fromWorktree?.gitRoot).toBe(mainRepoReal);
  });
});
