import { describe, it, expect, vi } from "vitest";
import { runPrStats } from "./prStats.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesDir = join(__dirname, "..", "..", "src", "analyzers", "__fixtures__");

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
      expect(parsed.schema).toBe("pr-stats/1");
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
});
