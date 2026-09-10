import { describe, it, expect, vi } from "vitest";
import { resolveProject, clearResolveProjectCache } from "./projectResolver.js";

describe("resolveProject", () => {
  it("normalizes paths, resolves via injected resolver, and returns project", async () => {
    clearResolveProjectCache();
    const resolver = vi.fn().mockResolvedValue("/home/user/repo");
    const result = await resolveProject("/home/user/repo/", {
      gitRootResolver: resolver,
    });

    expect(result).toEqual({
      cwd: "/home/user/repo",
      gitRoot: "/home/user/repo",
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith("/home/user/repo");
  });

  it("caches results so the resolver is only called once per normalized cwd", async () => {
    clearResolveProjectCache();
    const resolver = vi.fn().mockResolvedValue("/home/user/repo");

    const r1 = await resolveProject("/home/user/repo", {
      gitRootResolver: resolver,
    });
    const r2 = await resolveProject("/home/user/repo", {
      gitRootResolver: resolver,
    });

    expect(r1).toBe(r2);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("collapses worktree paths to parent repo root", async () => {
    clearResolveProjectCache();
    const resolver = vi
      .fn()
      .mockResolvedValue("/home/user/repo/.git/worktrees/feature-branch");

    const result = await resolveProject("/home/user/repo-worktree", {
      gitRootResolver: resolver,
    });

    expect(result).toEqual({
      cwd: "/home/user/repo-worktree",
      gitRoot: "/home/user/repo",
    });
  });

  it("returns null when resolver returns null", async () => {
    clearResolveProjectCache();
    const resolver = vi.fn().mockResolvedValue(null);

    const result = await resolveProject("/home/user/not-a-repo", {
      gitRootResolver: resolver,
    });

    expect(result).toBeNull();
  });

  it("trims trailing slashes from git root", async () => {
    clearResolveProjectCache();
    const resolver = vi.fn().mockResolvedValue("/home/user/repo/");

    const result = await resolveProject("/home/user/repo", {
      gitRootResolver: resolver,
    });

    expect(result).toEqual({
      cwd: "/home/user/repo",
      gitRoot: "/home/user/repo",
    });
  });
});
