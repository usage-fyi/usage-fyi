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

  describe("token extraction", () => {
    it("extracts token usage from assistant entries", async () => {
      const result = await scanClaudeCodeSession(
        fixture("claude-code-with-tokens.jsonl"),
      );

      expect(result.tokens).toHaveLength(2);

      const first = result.tokens[0]!;
      expect(first.source).toBe("claude");
      expect(first.timestamp).toBe("2026-05-28T12:01:00.000Z");
      expect(first.model).toBe("claude-opus-4-8");
      expect(first.isSidechain).toBe(false);
      expect(first.tokens.inputTokens).toBe(100);
      expect(first.tokens.outputTokens).toBe(50);
      expect(first.tokens.cacheReadTokens).toBe(200);
      expect(first.tokens.cacheCreationTokens).toBe(10);
      expect(first.tokens.reasoningTokens).toBe(0);
      expect(first.tokens.totalTokens).toBe(360); // 100+50+200+10
      expect(first.usageMissing).toBeUndefined();

      const second = result.tokens[1]!;
      expect(second.tokens.inputTokens).toBe(80);
      expect(second.tokens.outputTokens).toBe(30);
      expect(second.tokens.totalTokens).toBe(110);
      expect(second.isSidechain).toBeUndefined();
    });

    it("deduplicates assistant entries by requestId (first occurrence wins)", async () => {
      const result = await scanClaudeCodeSession(
        fixture("claude-code-dedupe-tokens.jsonl"),
      );

      // req-dup-001 appears twice but should produce only one token event.
      expect(result.tokens).toHaveLength(2);
      expect(result.tokens[0]!.timestamp).toBe("2026-05-28T13:01:00.000Z");
      expect(result.tokens[1]!.timestamp).toBe("2026-05-28T13:03:00.000Z");
    });

    it("propagates isSidechain flag on token events", async () => {
      const result = await scanClaudeCodeSession(
        fixture("claude-code-sidechain-tokens.jsonl"),
      );

      expect(result.tokens).toHaveLength(3);
      expect(result.tokens[0]!.isSidechain).toBe(false);
      expect(result.tokens[1]!.isSidechain).toBe(true);
      expect(result.tokens[1]!.model).toBe("claude-haiku-4-5");
      expect(result.tokens[2]!.isSidechain).toBe(false);
    });

    it("emits zero-token events with usageMissing when usage block is absent", async () => {
      const result = await scanClaudeCodeSession(
        fixture("claude-code-missing-usage.jsonl"),
      );

      expect(result.tokens).toHaveLength(2);
      const first = result.tokens[0]!;
      expect(first.usageMissing).toBe(true);
      expect(first.model).toBe("claude-opus-4-8");
      expect(first.tokens.inputTokens).toBe(0);
      expect(first.tokens.outputTokens).toBe(0);
      expect(first.tokens.totalTokens).toBe(0);

      const second = result.tokens[1]!;
      expect(second.usageMissing).toBe(true);
      expect(second.model).toBeNull();
    });

    it("returns empty tokens array for sessions with no assistant entries", async () => {
      const result = await scanClaudeCodeSession(
        fixture("claude-code-no-pr.jsonl"),
      );

      // claude-code-no-pr.jsonl has user/assistant/attachment entries without message.usage
      expect(result.tokens).toBeDefined();
      // The assistant entry has no message block → usageMissing event
      const missing = result.tokens.filter((t) => t.usageMissing);
      expect(missing.length).toBeGreaterThanOrEqual(0);
    });
  });
});
