import { describe, it, expect } from "vitest";
import {
  analyzePRStats,
  formatPRStatsTable,
} from "../../src/analyzers/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zeroBreakdown } from "../../src/analyzers/sources/tokenTypes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesDir = join(
  __dirname,
  "..",
  "..",
  "src",
  "analyzers",
  "__fixtures__",
);
const tokenFixturesDir = join(fixturesDir, "tokens");

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
      expect(["windowed", "session-only", "approximate"]).toContain(
        ev.tokensAttributed,
      );
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

// ─── Reconciliation test ──────────────────────────────────────────────────────
//
// Asserts that the sum of session tokens reported by analyzePRStats over the
// hand-built token fixtures matches the expected total derived by direct
// inspection of the JSONL files — the same calculation ccusage performs when
// it reads the same session files.
//
// If this test fails after a ccusage upgrade, check whether the token
// attribution schema has changed in:
//   packages/cli/src/analyzers/__fixtures__/tokens/
//   packages/cli/src/analyzers/sources/claudeCode.ts
//   packages/cli/src/analyzers/sources/codex.ts
//
// Expected totals (all on 2026-06-10; each plain message = input:100 + output:20 = 120):
//   claude-multi-pr:     8 messages × 120                          =  960
//   claude-dry-session:  3 messages × 120                          =  360
//   claude-sidechain:    120 + 60 + 120                            =  300
//   claude-dedupe:       120 (req-dd1, first occurrence) + 80      =  200
//   out-of-order:        3 × 120 (session-only; all tokens counted) = 360
//   unknown-model:       1 × 120                                   =  120
//   codex-cumulative:    3 × 180 (delta per event)                 =  540
//                                                          Total = 2840
//
// Tolerance ±1: integer arithmetic throughout; no boundary rounding occurs
// because all fixture events are pinned to the same UTC day. Tolerance is
// documented for forward-compatibility — it is not needed for this fixture set.
describe("reconciliation — token fixture totals match ccusage-derived expectation", () => {
  it("sum of bySession.tokens.totalTokens equals hand-computed fixture total", async () => {
    // Point both scanners at the same tokens/ directory.
    // Claude scanner: picks up all 7 JSONL files. The codex-cumulative file
    //   produces one extra 0-token session (cwd/sessionStart come from
    //   non-assistant entries; no assistant entries → 0 tokens counted).
    // Codex scanner: picks up all 7 JSONL files. The 6 Claude-format files
    //   produce cwd=null/sessionStart=null and are skipped by analyzePRStats.
    // Net: 7 real sessions + 1 extra 0-token session = sum unaffected.
    const report = await analyzePRStats({
      claudeProjectsDir: tokenFixturesDir,
      codexSessionsDir: tokenFixturesDir,
      gitRootResolver: async (cwd) => cwd,
    });

    expect(report.schema).toBe("pr-stats/2");

    // Verify stdout parsability: the report object itself is the parsed form;
    // round-trip through JSON to confirm no unserializable values.
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();

    const sessionTotal = report.bySession.reduce(
      (sum, s) => sum + s.tokens.totalTokens,
      0,
    );

    // Hand-computed expected total (see comments above for per-session breakdown).
    const EXPECTED_TOTAL = 2840;
    // Tolerance ±1: allows for one-day boundary rounding when ccusage buckets
    // events near UTC midnight. Not triggered by this fixture set.
    const TOLERANCE = 1;

    expect(Math.abs(sessionTotal - EXPECTED_TOTAL)).toBeLessThanOrEqual(
      TOLERANCE,
    );
  });
});
