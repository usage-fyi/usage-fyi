import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export interface ResolveProjectOptions {
  gitRootResolver: (cwd: string) => Promise<string | null>;
}

export interface ProjectResult {
  cwd: string;
  gitRoot: string;
}

const cache = new Map<string, Promise<ProjectResult | null>>();

function collapseWorktree(gitRoot: string): string {
  const marker = "/.git/worktrees/";
  const idx = gitRoot.indexOf(marker);
  if (idx !== -1) {
    return gitRoot.slice(0, idx);
  }
  return gitRoot;
}

async function normalizePath(cwd: string): Promise<string> {
  let normalized: string;
  try {
    normalized = await realpath(cwd);
  } catch {
    normalized = resolve(cwd);
  }
  // Trim trailing slashes, but preserve root "/"
  return normalized.replace(/\/+$/, "") || "/";
}

export async function resolveProject(
  cwd: string,
  options: ResolveProjectOptions,
): Promise<ProjectResult | null> {
  const normalized = await normalizePath(cwd);

  const cached = cache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }

  const promise = (async (): Promise<ProjectResult | null> => {
    const rawGitRoot = await options.gitRootResolver(normalized);
    if (rawGitRoot === null) {
      return null;
    }

    const gitRoot = collapseWorktree(rawGitRoot.replace(/\/+$/, "") || "/");

    return { cwd: normalized, gitRoot };
  })();

  cache.set(normalized, promise);
  return promise;
}

/** Clear the internal resolver cache — useful in tests. */
export function clearResolveProjectCache(): void {
  cache.clear();
}
