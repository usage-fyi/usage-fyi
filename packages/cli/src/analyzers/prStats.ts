export interface PREvent {
  prUrl: string; // https://github.com/owner/repo/pull/n
  prRepository: string; // owner/repo
  prNumber: number;
  sessionId: string;
  project: string; // canonical git root path
  source: "claude-code" | "codex" | "gemini";
  sessionStart: string; // ISO 8601
  prTimestamp: string; // ISO 8601
  sessionEnd: string; // ISO 8601
  msToFirstPR: number;
  msSessionTotal: number;
}

export interface PRProjectStats {
  prCount: number;
  sessionCount: number; // sessions with ≥ 1 PR
  sessionsWithNoPR: number;
  medianMsToFirstPR: number;
  p90MsToFirstPR: number;
}

export interface PRStatsReport {
  schema: "pr-stats/1";
  generatedAt: string;
  events: PREvent[];
  byProject: Record<string, PRProjectStats>;
}

export interface AnalyzePRStatsOpts {
  claudeProjectsDir?: string; // default: ~/.claude/projects
  codexSessionsDir?: string; // default: ~/.codex/sessions
  gitRootResolver?: (cwd: string) => string | null;
}

export async function analyzePRStats(
  _opts: AnalyzePRStatsOpts = {},
): Promise<PRStatsReport> {
  return {
    schema: "pr-stats/1",
    generatedAt: new Date().toISOString(),
    events: [],
    byProject: {},
  };
}
