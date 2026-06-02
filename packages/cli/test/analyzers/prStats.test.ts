import { describe, it, expect } from "vitest";
import { analyzePRStats, formatPRStatsTable } from "../../src/analyzers/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zeroBreakdown } from "../../src/analyzers/sources/tokenTypes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesDir = join(__dirname, "..", "..", "src", "analyzers", "__fixtures__");

describe("analyzePRStats", () => {
  it("returns empty report when directories do not exist", async () => {
    const report = await analyzePRStats({
      claudeProjectsDir: "/nonexistent/claude",
      codexSessionsDir: "/nonexistent/codex",
    });
    expect(report.schema).toBe("pr-stats/2");
    expect(report.events).toHaveLength(0);
    expect(report.bySession).toHaveLength(0);
    expect(Object.keys(report.byProject)).toHaveLength(0);
  });

  it("discovers and scans fixture files with a stubbed git root resolver", async () => {
    const report = await analyzePRStats({
      claudeProjectsDir: fixturesDir,
      codexSessionsDir: fixturesDir,
      gitRootResolver: async (cwd) => cwd,
    });

    // We should have events from the fixture files that have PRs.
    expect(report.events.length).toBeGreaterThan(0);

    // All events should have a project resolved.
    for (const ev of report.events) {
      expect(ev.project).toBeTruthy();
      expect(ev.prUrl).toMatch(/^https:\/\/github\.com\/.*\/pull\/\d+$/);
      // pr-stats/2 token fields should be present
      expect(ev.tokens).toBeDefined();
      expect(["windowed", "session-only", "approximate"]).toContain(ev.tokensAttributed);
      expect(Array.isArray(ev.models)).toBe(true);
    }
  });

  it("aggregates stats by project", async () => {
    const report = await analyzePRStats({
      claudeProjectsDir: fixturesDir,
      codexSessionsDir: fixturesDir,
      gitRootResolver: async (cwd) => cwd,
    });

    // There should be at least one project with stats.
    const projects = Object.keys(report.byProject);
    expect(projects.length).toBeGreaterThan(0);

    for (const proj of projects) {
      const stats = report.byProject[proj]!;
      expect(typeof stats.prCount).toBe("number");
      expect(typeof stats.sessionCount).toBe("number");
      expect(typeof stats.sessionsWithNoPR).toBe("number");
      // pr-stats/2 token fields
      expect(stats.productiveTokens).toBeDefined();
      expect(stats.dryTokens).toBeDefined();
      expect(stats.totalTokens).toBeDefined();
    }
  });

  it("populates bySession", async () => {
    const report = await analyzePRStats({
      claudeProjectsDir: fixturesDir,
      codexSessionsDir: fixturesDir,
      gitRootResolver: async (cwd) => cwd,
    });

    expect(Array.isArray(report.bySession)).toBe(true);
    for (const session of report.bySession) {
      expect(session.sessionId).toBeTruthy();
      expect(session.project).toBeTruthy();
      expect(session.tokens).toBeDefined();
    }
  });

  it("events are sorted by (project, prTimestamp, prUrl)", async () => {
    const report = await analyzePRStats({
      claudeProjectsDir: fixturesDir,
      codexSessionsDir: fixturesDir,
      gitRootResolver: async (cwd) => cwd,
    });

    const evs = report.events;
    for (let i = 1; i < evs.length; i++) {
      const a = evs[i - 1]!;
      const b = evs[i]!;
      const cmp =
        a.project.localeCompare(b.project) ||
        a.prTimestamp.localeCompare(b.prTimestamp) ||
        a.prUrl.localeCompare(b.prUrl);
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("byProject keys are sorted lexicographically", async () => {
    const report = await analyzePRStats({
      claudeProjectsDir: fixturesDir,
      codexSessionsDir: fixturesDir,
      gitRootResolver: async (cwd) => cwd,
    });

    const keys = Object.keys(report.byProject);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});

describe("formatPRStatsTable", () => {
  const zero = zeroBreakdown();

  it("renders a message when there are no projects", () => {
    const table = formatPRStatsTable({
      schema: "pr-stats/2",
      generatedAt: "2026-06-01T00:00:00Z",
      events: [],
      bySession: [],
      byProject: {},
    });
    expect(table).toContain("No PR stats found");
  });

  it("renders columns for project, PRs, median and p90", () => {
    const table = formatPRStatsTable({
      schema: "pr-stats/2",
      generatedAt: "2026-06-01T00:00:00Z",
      events: [
        {
          prUrl: "https://github.com/owner/repo/pull/1",
          prRepository: "owner/repo",
          prNumber: 1,
          sessionId: "s1",
          project: "/home/user/repo",
          source: "claude-code",
          sessionStart: "2026-06-01T00:00:00Z",
          prTimestamp: "2026-06-01T01:00:00Z",
          sessionEnd: "2026-06-01T02:00:00Z",
          msToFirstPR: 3600000,
          msSessionTotal: 7200000,
          tokens: zero,
          tokensAttributed: "windowed",
          models: [],
          estimatedCostUsd: null,
          msFromPrevPR: null,
        },
      ],
      bySession: [],
      byProject: {
        "/home/user/repo": {
          prCount: 1,
          sessionCount: 1,
          sessionsWithNoPR: 0,
          medianMsToFirstPR: 3600000,
          p90MsToFirstPR: 3600000,
          productiveTokens: zero,
          dryTokens: zero,
          overheadTokens: zero,
          sidechainTokens: zero,
          totalTokens: zero,
          dryTokenShare: 0,
          tokensPerPR: null,
          prsPerMTok: null,
          cacheHitRatio: null,
          outputShare: null,
          estimatedCostUsd: null,
        },
      },
    });
    expect(table).toContain("Project");
    expect(table).toContain("PRs");
    expect(table).toContain("Median TTP");
    expect(table).toContain("P90 TTP");
    expect(table).toContain("/home/user/repo");
    expect(table).toContain("1h");
  });

  it("shows dash for null percentiles", () => {
    const table = formatPRStatsTable({
      schema: "pr-stats/2",
      generatedAt: "2026-06-01T00:00:00Z",
      events: [],
      bySession: [],
      byProject: {
        "/home/user/repo": {
          prCount: 0,
          sessionCount: 1,
          sessionsWithNoPR: 1,
          medianMsToFirstPR: null,
          p90MsToFirstPR: null,
          productiveTokens: zero,
          dryTokens: zero,
          overheadTokens: zero,
          sidechainTokens: zero,
          totalTokens: zero,
          dryTokenShare: 0,
          tokensPerPR: null,
          prsPerMTok: null,
          cacheHitRatio: null,
          outputShare: null,
          estimatedCostUsd: null,
        },
      },
    });
    expect(table).toContain("-");
  });
});
