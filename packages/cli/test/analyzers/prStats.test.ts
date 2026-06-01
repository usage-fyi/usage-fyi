import { describe, it, expect } from "vitest";
import { analyzePRStats, formatPRStatsTable } from "../../src/analyzers/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesDir = join(__dirname, "..", "..", "src", "analyzers", "__fixtures__");

describe("analyzePRStats", () => {
  it("returns empty report when directories do not exist", async () => {
    const report = await analyzePRStats({
      claudeProjectsDir: "/nonexistent/claude",
      codexSessionsDir: "/nonexistent/codex",
    });
    expect(report.schema).toBe("pr-stats/1");
    expect(report.events).toHaveLength(0);
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
    }
  });
});

describe("formatPRStatsTable", () => {
  it("renders a message when there are no projects", () => {
    const table = formatPRStatsTable({
      schema: "pr-stats/1",
      generatedAt: "2026-06-01T00:00:00Z",
      events: [],
      byProject: {},
    });
    expect(table).toContain("No PR stats found");
  });

  it("renders columns for project, PRs, median and p90", () => {
    const table = formatPRStatsTable({
      schema: "pr-stats/1",
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
        },
      ],
      byProject: {
        "/home/user/repo": {
          prCount: 1,
          sessionCount: 1,
          sessionsWithNoPR: 0,
          medianMsToFirstPR: 3600000,
          p90MsToFirstPR: 3600000,
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
      schema: "pr-stats/1",
      generatedAt: "2026-06-01T00:00:00Z",
      events: [],
      byProject: {
        "/home/user/repo": {
          prCount: 0,
          sessionCount: 1,
          sessionsWithNoPR: 1,
          medianMsToFirstPR: null,
          p90MsToFirstPR: null,
        },
      },
    });
    expect(table).toContain("-");
  });
});
