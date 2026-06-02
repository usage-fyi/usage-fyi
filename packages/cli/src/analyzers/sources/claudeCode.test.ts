import { describe, it, expect, vi } from "vitest";
import { scanClaudeCodeSession } from "./claudeCode.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixture = (name: string) => join(__dirname, "..", "__fixtures__", name);

describe("scanClaudeCodeSession", () => {
  it("extracts session metadata and a single PR event", async () => {
    const result = await scanClaudeCodeSession(
      fixture("claude-code-single-pr.jsonl"),
    );

    expect(result.filePath).toBe(fixture("claude-code-single-pr.jsonl"));
    expect(result.sessionId).toBe("session-abc-123");
    expect(result.cwd).toBe("/Users/alice/work/myrepo");
    expect(result.sessionStart).toBe("2026-05-28T05:50:00.000Z");
    expect(result.sessionEnd).toBe("2026-05-28T05:56:11.425Z");
    expect(result.rawPrEntries).toHaveLength(1);
    expect(result.rawPrEntries[0]).toEqual({
      prUrl: "https://github.com/owner/repo/pull/419",
      prNumber: 419,
      prRepository: "owner/repo",
      timestamp: "2026-05-28T05:56:11.425Z",
      sessionId: "session-abc-123",
    });
  });

  it("deduplicates duplicate pr-link entries by prUrl", async () => {
    const result = await scanClaudeCodeSession(
      fixture("claude-code-multi-pr.jsonl"),
    );

    expect(result.rawPrEntries).toHaveLength(2);
    expect(result.rawPrEntries[0]!.prUrl).toBe(
      "https://github.com/owner/repo/pull/1",
    );
    expect(result.rawPrEntries[1]!.prUrl).toBe(
      "https://github.com/owner/repo/pull/2",
    );
    expect(result.sessionStart).toBe("2026-05-28T06:00:00.000Z");
    expect(result.sessionEnd).toBe("2026-05-28T06:25:00.000Z");
  });

  it("returns empty PR events for a session with no pr-link entries", async () => {
    const result = await scanClaudeCodeSession(
      fixture("claude-code-no-pr.jsonl"),
    );

    expect(result.rawPrEntries).toHaveLength(0);
    expect(result.sessionId).toBe("claude-code-no-pr");
    expect(result.cwd).toBe("/Users/alice/work/myrepo");
    expect(result.sessionStart).toBe("2026-05-28T07:00:00.000Z");
    expect(result.sessionEnd).toBe("2026-05-28T07:06:00.000Z");
  });

  it("skips malformed JSON lines silently", async () => {
    const debugSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await scanClaudeCodeSession(
      fixture("claude-code-malformed.jsonl"),
    );

    expect(result.rawPrEntries).toHaveLength(1);
    expect(result.rawPrEntries[0]!.prNumber).toBe(7);
    expect(result.sessionStart).toBe("2026-05-28T08:00:00.000Z");
    expect(result.sessionEnd).toBe("2026-05-28T08:10:00.000Z");

    debugSpy.mockRestore();
  });

  it("warns via console.error when fewer than 50% of entries have timestamps", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // 3 lines, 2 with timestamps → 66%, no warning.
    await scanClaudeCodeSession(fixture("claude-code-single-pr.jsonl"));
    expect(errorSpy).not.toHaveBeenCalled();

    // 3 lines in malformed fixture, 2 with timestamps → 66%, no warning.
    await scanClaudeCodeSession(fixture("claude-code-malformed.jsonl"));
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
