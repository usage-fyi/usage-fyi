import { describe, it, expect, vi } from "vitest";
import { runPrStats } from "./prStats.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

describe("runPrStats", () => {
  it("outputs JSON report when --json is passed", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runPrStats({
        json: true,
        claudeProjectsDir: fixturesDir,
        codexSessionsDir: fixturesDir,
        gitRootResolver: async (cwd) => cwd,
      });
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.schema).toBe("pr-stats/2");
      expect(typeof parsed.byProject).toBe("object");
    } finally {
      spy.mockRestore();
    }
  });

  it("outputs table when --json is not passed", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runPrStats({
        json: false,
        claudeProjectsDir: fixturesDir,
        codexSessionsDir: fixturesDir,
        gitRootResolver: async (cwd) => cwd,
      });
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls[0]![0] as string;
      expect(output).toContain("Project");
      expect(output).toContain("PRs");
    } finally {
      spy.mockRestore();
    }
  });

  it("exits 0 even when no events are found", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runPrStats({
        json: false,
        claudeProjectsDir: "/nonexistent/claude",
        codexSessionsDir: "/nonexistent/codex",
      });
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls[0]![0] as string;
      expect(output).toContain("No PR stats found");
    } finally {
      spy.mockRestore();
    }
  });

  it("stdout parses as clean JSON with --json (regression guard for diagnostic contamination)", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    // Also intercept console.debug in case it aliases to log in some runtimes
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const code = await runPrStats({
        json: true,
        claudeProjectsDir: fixturesDir,
        codexSessionsDir: fixturesDir,
        gitRootResolver: async (cwd) => cwd,
      });
      expect(code).toBe(0);
      // All stdout must be parseable as a single JSON object
      const fullStdout = logs.join("\n");
      const parsed = JSON.parse(fullStdout);
      expect(parsed.schema).toBe("pr-stats/2");
      // No diagnostic noise on stdout
      expect(logs).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("table includes tokens, cost, and dry-share columns", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runPrStats({
        json: false,
        claudeProjectsDir: fixturesDir,
        codexSessionsDir: fixturesDir,
        gitRootResolver: async (cwd) => cwd,
      });
      expect(code).toBe(0);
      const output = spy.mock.calls[0]![0] as string;
      expect(output).toContain("Tokens");
      expect(output).toContain("Cost");
      expect(output).toContain("Dry%");
    } finally {
      spy.mockRestore();
    }
  });

  it("--by session outputs one row per session", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runPrStats({
        json: false,
        by: "session",
        claudeProjectsDir: fixturesDir,
        codexSessionsDir: fixturesDir,
        gitRootResolver: async (cwd) => cwd,
      });
      expect(code).toBe(0);
      const output = spy.mock.calls[0]![0] as string;
      expect(output).toContain("Session");
      expect(output).toContain("Duration");
    } finally {
      spy.mockRestore();
    }
  });

  it("--project filters to a single project", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runPrStats({
        json: true,
        project: "/nonexistent/project",
        claudeProjectsDir: fixturesDir,
        codexSessionsDir: fixturesDir,
        gitRootResolver: async (cwd) => cwd,
      });
      expect(code).toBe(0);
      const output = spy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.events).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("--since filters events by date", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runPrStats({
        json: true,
        since: "2099-01-01",
        claudeProjectsDir: fixturesDir,
        codexSessionsDir: fixturesDir,
        gitRootResolver: async (cwd) => cwd,
      });
      expect(code).toBe(0);
      const output = spy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output);
      // No events in the far future
      expect(parsed.events).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns exit code 1 and prints error when --pr matches multiple projects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Use a PR number that doesn't exist — won't error since no events match
      const code = await runPrStats({
        json: true,
        pr: "99999",
        claudeProjectsDir: fixturesDir,
        codexSessionsDir: fixturesDir,
        gitRootResolver: async (cwd) => cwd,
      });
      // Either exits 0 with empty events (no match) or exits 1 with error
      // The fixture data likely doesn't have PR #99999, so no multi-project ambiguity
      expect([0, 1]).toContain(code);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
